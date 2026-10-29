<#
.SYNOPSIS
  Builds dist\MediaFolderPanel-Setup.exe, one file that installs the panel.
.DESCRIPTION
  Stages helper\, panel\, installer\ and dist\MediaFolderPanel.avpi into a zip with forward-slash
  entry names, embeds it in Setup.exe with the .NET Framework C# compiler (csc.exe, built into
  Windows), and writes the result to dist\. dist\MediaFolderPanel.avpi must already exist
  (see README "Package and install the .avpi").
#>
$ErrorActionPreference = 'Stop'

$root   = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dist   = Join-Path $root 'dist'
$avpi   = Join-Path $dist 'MediaFolderPanel.avpi'
$csc    = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$work   = Join-Path $env:TEMP 'mfp-setup-build'
$zipTmp = Join-Path $work 'payload.zip'
$out    = Join-Path $dist 'MediaFolderPanel-Setup.exe'

if (-not (Test-Path -LiteralPath $avpi)) { throw "Missing $avpi. Build the .avpi first." }
if (-not (Test-Path -LiteralPath $csc))  { throw "csc.exe not found at $csc (.NET Framework 4 is required)." }

Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
$stage = Join-Path $work 'stage'
New-Item -ItemType Directory -Path $stage, (Join-Path $stage 'dist') | Out-Null
Copy-Item (Join-Path $root 'helper')  (Join-Path $stage 'helper')  -Recurse
Copy-Item (Join-Path $root 'panel')   (Join-Path $stage 'panel')   -Recurse
Copy-Item (Join-Path $root 'installer') (Join-Path $stage 'installer') -Recurse
Remove-Item (Join-Path $stage 'installer\setup') -Recurse -Force
Copy-Item $avpi (Join-Path $stage 'dist\MediaFolderPanel.avpi')

# Compress-Archive writes backslashes on Windows PowerShell 5.1; the zip format wants forward slashes.
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$dst = [IO.Compression.ZipFile]::Open($zipTmp, 'Create')
Get-ChildItem -LiteralPath $stage -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($stage.Length + 1).Replace('\', '/')
    $entry = $dst.CreateEntry($rel, 'Optimal')
    $in = [IO.File]::OpenRead($_.FullName)
    $o = $entry.Open(); $in.CopyTo($o); $o.Dispose(); $in.Dispose()
}
$dst.Dispose()

$src = Join-Path $PSScriptRoot 'Setup.cs'
& $csc /nologo /target:winexe /optimize+ "/out:$out" "/resource:$zipTmp,payload.zip" /reference:System.Windows.Forms.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll $src
if ($LASTEXITCODE -ne 0) { throw "csc.exe failed with exit code $LASTEXITCODE" }

Write-Output ("Built {0} ({1:N0} bytes)" -f $out, (Get-Item $out).Length)
