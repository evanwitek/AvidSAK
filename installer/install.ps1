<#
.SYNOPSIS
  Installs the Media Folder Panel helper and .avpi plugin bundle.
.DESCRIPTION
  Run from the MediaFolderPanel\installer folder (or the unzipped installer package).
  Steps: admin check, Node.js check/install, port check, copy helper+panel to
  C:\ProgramData\MediaFolderPanel, copy .avpi to C:\ProgramData\Avid\PanelSDKPlugins,
  register + start the logon scheduled task, verify the helper, print a summary.
.PARAMETER DryRun
  Print what would be done. Changes nothing and does not require admin.
.PARAMETER NoPause
  Do not wait for Enter at the end (for scripted runs).
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'

$Port          = 47831
$TaskName      = 'MediaFolderPanelHelper'
$InstallDir    = Join-Path $env:ProgramData 'MediaFolderPanel'
$PluginDir     = Join-Path $env:ProgramData 'Avid\PanelSDKPlugins'
$AvpiName      = 'MediaFolderPanel.avpi'
$MinNodeMajor  = 14
$NodeFallback  = Join-Path $env:ProgramFiles 'nodejs\node.exe'
$SourceRoot    = Split-Path -Parent $PSScriptRoot
$Tag           = ''
if ($DryRun) { $Tag = '[DRY RUN] ' }

function Write-Step([int]$n, [string]$text) {
    Write-Host ''
    Write-Host ("[{0}/7] {1}" -f $n, $text) -ForegroundColor Cyan
}

function Write-Result([string]$status, [string]$msg) {
    $color = 'Gray'
    switch ($status) {
        'OK'   { $color = 'Green' }
        'FAIL' { $color = 'Red' }
        'WARN' { $color = 'Yellow' }
        'PLAN' { $color = 'Magenta' }
        'INFO' { $color = 'Gray' }
    }
    Write-Host ("  [{0}] {1}" -f $status, $msg) -ForegroundColor $color
}

function Exit-Script([int]$code) {
    if (-not $NoPause) {
        Write-Host ''
        Read-Host 'Press Enter to close' | Out-Null
    }
    exit $code
}

function Stop-Install([string]$msg) {
    Write-Result 'FAIL' $msg
    Write-Host ''
    Write-Host 'Installation stopped. Nothing further was changed.' -ForegroundColor Red
    Exit-Script 1
}

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Returns a version object for a node executable, or $null if it cannot be run.
function Get-NodeVersion([string]$exe) {
    if (-not $exe) { return $null }
    try {
        $out = (& $exe --version 2>&1 | Out-String).Trim()
    } catch {
        return $null
    }
    if ($out -match '^v(\d+)\.(\d+)\.(\d+)') {
        return New-Object PSObject -Property @{
            Exe = $exe; Text = $out; Major = [int]$Matches[1]
        }
    }
    return $null
}

# Finds a usable node: PATH first, then the standard install location.
function Find-Node {
    $cmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) {
        $v = Get-NodeVersion $cmd.Source
        if ($v) { return $v }
    }
    if (Test-Path -LiteralPath $NodeFallback) {
        return Get-NodeVersion $NodeFallback
    }
    return $null
}

function Test-PortFree {
    $l = $null
    try {
        $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
        $l.Start()
        return $true
    } catch {
        return $false
    } finally {
        if ($l) { try { $l.Stop() } catch { } }
    }
}

function Get-PortOwnerText {
    try {
        $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
        if ($c) {
            $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
            if ($proc) { return ("{0} (PID {1})" -f $proc.ProcessName, $proc.Id) }
            return ("PID {0}" -f $c.OwningProcess)
        }
    } catch { }
    return 'unknown process'
}

function Get-OurProcesses {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and (
            ($_.Name -ieq 'node.exe' -and $_.CommandLine -like '*MediaFolderPanel*server.js*') -or
            ($_.Name -ieq 'wscript.exe' -and $_.CommandLine -like '*MediaFolderPanel*run-helper.vbs*')) }
}

# Stops an earlier copy of our own helper (scheduled task, launcher, node).
function Stop-OurHelper {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
    # launcher first so it does not see node die
    foreach ($p in (Get-OurProcesses | Sort-Object { if ($_.Name -ieq 'wscript.exe') { 0 } else { 1 } })) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Test-OurHelperPresent {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { return $true }
    return [bool](Get-OurProcesses)
}

try {
    Write-Host 'Media Folder Panel installer' -ForegroundColor White
    if ($DryRun) { Write-Host 'DRY RUN: no changes will be made.' -ForegroundColor Magenta }

    # ---------------------------------------------------------------- 1
    Write-Step 1 'Administrator rights'
    if (Test-IsAdmin) {
        Write-Result 'OK' 'Running as administrator.'
    } elseif ($DryRun) {
        Write-Result 'PLAN' 'Not elevated. A real run would relaunch itself elevated (UAC prompt) and exit.'
    } else {
        Write-Result 'INFO' 'Not elevated. Relaunching with administrator rights (accept the UAC prompt)...'
        $argList = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $PSCommandPath
        if ($NoPause) { $argList += ' -NoPause' }
        try {
            Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs | Out-Null
        } catch {
            Stop-Install ('Could not relaunch elevated: ' + $_.Exception.Message)
        }
        Write-Result 'OK' 'Elevated copy started in a new window. This window can be closed.'
        if (-not $NoPause) { Start-Sleep -Seconds 3 }
        exit 0
    }

    $srcHelper = Join-Path $SourceRoot 'helper'
    $srcPanel  = Join-Path $SourceRoot 'panel'
    $srcAvpi   = Join-Path $SourceRoot ('dist\' + $AvpiName)
    $required = @(
        (Join-Path $srcHelper 'server.js'),
        (Join-Path $srcHelper 'config.json'),
        (Join-Path $srcPanel 'index.html'),
        (Join-Path $srcPanel 'icon.svg'),
        (Join-Path $srcPanel 'sdk\mcapi-bundle.js'),
        $srcAvpi
    )
    $missing = @($required | Where-Object { -not (Test-Path -LiteralPath $_) })
    if ($missing.Count -gt 0) {
        Stop-Install ("Installer files are missing (run the installer from the MediaFolderPanel folder layout):`r`n    " + ($missing -join "`r`n    "))
    }
    Write-Result 'OK' ("Source files found under {0}" -f $SourceRoot)

    # ---------------------------------------------------------------- 2
    Write-Step 2 ('Node.js (v{0} or newer)' -f $MinNodeMajor)
    $node = Find-Node
    if ($node -and $node.Major -ge $MinNodeMajor) {
        Write-Result 'OK' ("Found Node.js {0} at {1}" -f $node.Text, $node.Exe)
    } else {
        if ($node) {
            Write-Result 'WARN' ("Found Node.js {0} at {1}, which is older than v{2}." -f $node.Text, $node.Exe, $MinNodeMajor)
        } else {
            Write-Result 'WARN' 'Node.js was not found.'
        }
        $winget = $null
        $wc = Get-Command winget -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($wc) {
            $winget = $wc.Source
        } else {
            $alt = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'
            if (Test-Path -LiteralPath $alt) { $winget = $alt }
        }
        if (-not $winget) {
            Stop-Install ('winget is not available, so Node.js cannot be installed automatically. Install the Node.js LTS from https://nodejs.org/en/download and run this installer again.')
        }
        if ($DryRun) {
            Write-Result 'PLAN' ('Would run: winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements')
            Write-Result 'PLAN' ("Then re-check Node.js by full path ({0})." -f $NodeFallback)
            $node = New-Object PSObject -Property @{ Exe = $NodeFallback; Text = '(not yet installed)'; Major = 0 }
        } else {
            Write-Result 'INFO' 'Installing Node.js LTS with winget (this can take a minute)...'
            & $winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
            $wgExit = $LASTEXITCODE
            Write-Result 'INFO' ("winget exited with code {0}." -f $wgExit)
            # PATH may not have refreshed in this process: check by full path, then PATH again.
            $node = $null
            if (Test-Path -LiteralPath $NodeFallback) { $node = Get-NodeVersion $NodeFallback }
            if (-not $node -or $node.Major -lt $MinNodeMajor) {
                $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
                $node = Find-Node
            }
            if (-not $node -or $node.Major -lt $MinNodeMajor) {
                Stop-Install ("Node.js v{0}+ is still not available after the winget install (winget exit code {1}). Install the Node.js LTS from https://nodejs.org/en/download and run this installer again." -f $MinNodeMajor, $wgExit)
            }
            Write-Result 'OK' ("Node.js {0} installed at {1}" -f $node.Text, $node.Exe)
        }
    }
    $NodeExe = $node.Exe

    # ---------------------------------------------------------------- 3
    Write-Step 3 ("Port 127.0.0.1:{0}" -f $Port)
    if (Test-PortFree) {
        Write-Result 'OK' ("Port {0} is free." -f $Port)
    } elseif (Test-OurHelperPresent) {
        $owner = Get-PortOwnerText
        if ($DryRun) {
            Write-Result 'PLAN' ("Port {0} is in use by {1}; an earlier Media Folder Panel install seems to be present. A real run would stop its helper first, then re-check." -f $Port, $owner)
        } else {
            Write-Result 'INFO' ("Port {0} is in use by {1}. An earlier Media Folder Panel helper seems to be present; stopping it for the reinstall..." -f $Port, $owner)
            Stop-OurHelper
            $free = $false
            for ($i = 0; $i -lt 10; $i++) {
                if (Test-PortFree) { $free = $true; break }
                Start-Sleep -Milliseconds 500
            }
            if (-not $free) {
                Stop-Install ("Port {0} on 127.0.0.1 is still in use by {1} after stopping the old helper. Free the port and run this installer again." -f $Port, (Get-PortOwnerText))
            }
            Write-Result 'OK' ("Old helper stopped; port {0} is now free." -f $Port)
        }
    } elseif ($DryRun) {
        Write-Result 'WARN' ("Port {0} on 127.0.0.1 is in use by {1}, which is not a Media Folder Panel install. A real run would STOP here with this message. Continuing the dry run." -f $Port, (Get-PortOwnerText))
    } else {
        Stop-Install ("Port {0} on 127.0.0.1 is already in use by {1}. The Media Folder Panel helper needs this port (it is also fixed in avid-manifest.json). Stop that program and run this installer again." -f $Port, (Get-PortOwnerText))
    }

    # ---------------------------------------------------------------- 4
    Write-Step 4 ("Copy helper and panel to {0}" -f $InstallDir)
    $dstHelper = Join-Path $InstallDir 'helper'
    $dstPanel  = Join-Path $InstallDir 'panel'
    $dstConfig = Join-Path $dstHelper 'config.json'
    $keepConfig = Test-Path -LiteralPath $dstConfig
    if ($keepConfig) {
        Write-Result 'INFO' ("Existing config.json found at {0}: it will be kept (your edits survive the reinstall)." -f $dstConfig)
    } else {
        Write-Result 'INFO' 'No existing config.json: the default one will be installed.'
    }
    if ($DryRun) {
        Write-Result 'PLAN' ("Would replace {0} and {1} (helper keeps config.json if present)." -f $dstHelper, $dstPanel)
        Write-Result 'PLAN' 'Would copy helper\, panel\ (including panel\sdk\ and icon.svg). sdk-build\ and dist\ are not copied.'
        Write-Result 'PLAN' ("Would write the hidden launcher {0}" -f (Join-Path $InstallDir 'run-helper.vbs'))
        Write-Result 'PLAN' 'Would allow the Users group to edit config.json.'
    } else {
        New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
        # helper: clear everything except config.json, then copy
        if (Test-Path -LiteralPath $dstHelper) {
            Get-ChildItem -LiteralPath $dstHelper -Force |
                Where-Object { -not ($keepConfig -and $_.Name -ieq 'config.json') } |
                Remove-Item -Recurse -Force
        } else {
            New-Item -ItemType Directory -Force -Path $dstHelper | Out-Null
        }
        Get-ChildItem -LiteralPath $srcHelper -Force |
            Where-Object { -not ($keepConfig -and $_.Name -ieq 'config.json') } |
            Copy-Item -Destination $dstHelper -Recurse -Force
        # panel: replace wholesale (includes sdk\ and icon.svg)
        if (Test-Path -LiteralPath $dstPanel) { Remove-Item -LiteralPath $dstPanel -Recurse -Force }
        Copy-Item -LiteralPath $srcPanel -Destination $dstPanel -Recurse -Force
        # let normal users edit the config without admin rights
        & icacls.exe $dstConfig /grant '*S-1-5-32-545:(M)' | Out-Null

        # hidden launcher: wscript runs node with no window and returns node's exit code
        $serverJs = Join-Path $dstHelper 'server.js'
        $vbsPath  = Join-Path $InstallDir 'run-helper.vbs'
        $vbs = @(
            'Option Explicit',
            'Dim sh, cmd',
            'Set sh = CreateObject("WScript.Shell")',
            ('cmd = Chr(34) & "{0}" & Chr(34) & " " & Chr(34) & "{1}" & Chr(34)' -f $NodeExe, $serverJs),
            ('sh.CurrentDirectory = "{0}"' -f $dstHelper),
            'WScript.Quit sh.Run(cmd, 0, True)'
        )
        Set-Content -LiteralPath $vbsPath -Value $vbs -Encoding ASCII

        foreach ($f in @($serverJs, (Join-Path $dstPanel 'index.html'), (Join-Path $dstPanel 'sdk\mcapi-bundle.js'), (Join-Path $dstPanel 'icon.svg'), $dstConfig, $vbsPath)) {
            if (-not (Test-Path -LiteralPath $f)) { Stop-Install ("Copy check failed, missing: {0}" -f $f) }
        }
        Write-Result 'OK' ("Copied helper\ and panel\ to {0}" -f $InstallDir)
        if ($keepConfig) { Write-Result 'OK' 'Kept your existing config.json.' }
        Write-Result 'OK' ("Wrote hidden launcher {0}" -f $vbsPath)
    }

    # ---------------------------------------------------------------- 5
    Write-Step 5 ("Copy {0} to {1}" -f $AvpiName, $PluginDir)
    if ($DryRun) {
        Write-Result 'PLAN' ("Would create {0} if missing and copy {1} there (overwrite)." -f $PluginDir, $srcAvpi)
    } else {
        New-Item -ItemType Directory -Force -Path $PluginDir | Out-Null
        Copy-Item -LiteralPath $srcAvpi -Destination (Join-Path $PluginDir $AvpiName) -Force
        if (-not (Test-Path -LiteralPath (Join-Path $PluginDir $AvpiName))) { Stop-Install 'The .avpi copy did not land in the plugin folder.' }
        Write-Result 'OK' ("Copied to {0}" -f (Join-Path $PluginDir $AvpiName))
    }

    # ---------------------------------------------------------------- 6
    Write-Step 6 ("Scheduled task '{0}' and helper check" -f $TaskName)
    if ($DryRun) {
        Write-Result 'PLAN' ("Would register task '{0}': at logon of any user, runs wscript.exe //B //Nologo run-helper.vbs, which runs hidden: `"{1}`" `"{2}`"" -f $TaskName, $NodeExe, (Join-Path $InstallDir 'helper\server.js'))
        Write-Result 'PLAN' 'Task settings: hidden, restart every 1 minute on failure (up to 999 times), no time limit, start on battery.'
        Write-Result 'PLAN' 'Would start the task now and request http://localhost:47831/api/roots (up to ~20 s of retries).'
    } else {
        $vbsPath = Join-Path $InstallDir 'run-helper.vbs'
        $action = New-ScheduledTaskAction -Execute 'wscript.exe' `
            -Argument ('//B //Nologo "{0}"' -f $vbsPath) -WorkingDirectory (Join-Path $InstallDir 'helper')
        $trigger = New-ScheduledTaskTrigger -AtLogOn
        $principal = New-ScheduledTaskPrincipal -GroupId 'BUILTIN\Users' -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable `
            -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
            -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
            -Principal $principal -Settings $settings -Force `
            -Description 'Starts the Media Folder Panel helper (Media Composer panel) at user logon.' | Out-Null
        Write-Result 'OK' ("Registered scheduled task '{0}' (runs at logon of any user, hidden, restarts on failure)." -f $TaskName)

        Start-ScheduledTask -TaskName $TaskName
        Write-Result 'INFO' 'Started the task. Waiting for the helper to answer...'
        $resp = $null
        $lastErr = ''
        foreach ($u in @('http://localhost:47831/api/roots', 'http://127.0.0.1:47831/api/roots')) {
            for ($i = 0; $i -lt 10 -and -not $resp; $i++) {
                try {
                    $resp = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 3
                    $verifiedUrl = $u
                } catch {
                    $lastErr = $_.Exception.Message
                    Start-Sleep -Seconds 1
                }
            }
            if ($resp) { break }
        }
        if ($resp -and $resp.StatusCode -eq 200) {
            Write-Result 'OK' ("GET {0} -> HTTP 200: {1}" -f $verifiedUrl, $resp.Content)
        } else {
            Write-Result 'FAIL' ("The helper did not answer on port {0}: {1}" -f $Port, $lastErr)
            Write-Result 'INFO' ("Task state: {0}. Try running the helper by hand to see errors: `"{1}`" `"{2}`"" -f (Get-ScheduledTask -TaskName $TaskName).State, $NodeExe, (Join-Path $InstallDir 'helper\server.js'))
            $script:helperFailed = $true
        }
    }

    # ---------------------------------------------------------------- 7
    Write-Step 7 'Summary'
    if ($DryRun) {
        Write-Host '  Dry run finished. A real run would install:' -ForegroundColor Magenta
    } else {
        Write-Host '  Installed:' -ForegroundColor Green
    }
    Write-Host ("    Helper + panel : {0}" -f $InstallDir)
    Write-Host ("    Config         : {0}  (edit allowedRoots, then restart the task)" -f (Join-Path $InstallDir 'helper\config.json'))
    Write-Host ("    Plugin bundle  : {0}" -f (Join-Path $PluginDir $AvpiName))
    Write-Host ("    Scheduled task : {0}  (at logon, hidden, runs {1})" -f $TaskName, $NodeExe)
    Write-Host ("    Panel URL      : http://localhost:{0}/" -f $Port)
    Write-Host ''
    Write-Host '  Next:' -ForegroundColor Yellow
    Write-Host '    - Restart Media Composer, or run "panelsdk reinit" in its Console (Ctrl+6).'
    Write-Host '    - The .avpi still needs the Avid on-boarding/signing described in the README'
    Write-Host '      (or Avid-issued developer toggle files). This installer does not provide either.'
    Write-Host '    - To change the folders the panel may read, edit config.json, then in an admin'
    Write-Host ("      PowerShell run: Stop-ScheduledTask {0}; Start-ScheduledTask {0}" -f $TaskName)
    Write-Host '    - To remove everything, run uninstall.ps1 from this folder.'
    if ($script:helperFailed) {
        Write-Host ''
        Write-Result 'WARN' 'Install finished, but the helper check in step 6 failed. See the message above.'
        Exit-Script 2
    }
    Exit-Script 0
} catch {
    Write-Result 'FAIL' ($_.Exception.Message)
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
    Exit-Script 1
}
