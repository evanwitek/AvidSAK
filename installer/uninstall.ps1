<#
.SYNOPSIS
  Removes the Media Folder Panel helper, scheduled task, .avpi and install folder.
.PARAMETER DryRun
  Print what would be done. Changes nothing and does not require admin.
.PARAMETER Force
  Skip the confirmation prompt.
.PARAMETER NoPause
  Do not wait for Enter at the end.
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Force,
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'

$Port       = 47831
$TaskName   = 'MediaFolderPanelHelper'
$InstallDir = Join-Path $env:ProgramData 'MediaFolderPanel'
$AvpiPath   = Join-Path $env:ProgramData 'Avid\PanelSDKPlugins\MediaFolderPanel.avpi'

function Write-Result([string]$status, [string]$msg) {
    $color = 'Gray'
    switch ($status) {
        'OK'   { $color = 'Green' }
        'FAIL' { $color = 'Red' }
        'WARN' { $color = 'Yellow' }
        'PLAN' { $color = 'Magenta' }
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

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-OurProcesses {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and (
            ($_.Name -ieq 'node.exe' -and $_.CommandLine -like '*MediaFolderPanel*server.js*') -or
            ($_.Name -ieq 'wscript.exe' -and $_.CommandLine -like '*MediaFolderPanel*run-helper.vbs*')) }
}

try {
    Write-Host 'Media Folder Panel uninstaller' -ForegroundColor White
    if ($DryRun) { Write-Host 'DRY RUN: no changes will be made.' -ForegroundColor Magenta }

    Write-Host ''
    Write-Host 'Administrator rights' -ForegroundColor Cyan
    if (Test-IsAdmin) {
        Write-Result 'OK' 'Running as administrator.'
    } elseif ($DryRun) {
        Write-Result 'PLAN' 'Not elevated. A real run would relaunch itself elevated (UAC prompt) and exit.'
    } else {
        Write-Result 'INFO' 'Not elevated. Relaunching with administrator rights (accept the UAC prompt)...'
        $argList = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $PSCommandPath
        if ($Force)   { $argList += ' -Force' }
        if ($NoPause) { $argList += ' -NoPause' }
        try {
            Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs | Out-Null
        } catch {
            Write-Result 'FAIL' ('Could not relaunch elevated: ' + $_.Exception.Message)
            Exit-Script 1
        }
        Write-Result 'OK' 'Elevated copy started in a new window. This window can be closed.'
        if (-not $NoPause) { Start-Sleep -Seconds 3 }
        exit 0
    }

    Write-Host ''
    Write-Host 'This will remove:' -ForegroundColor Cyan
    Write-Host ("  - scheduled task  {0} (and stop the running helper)" -f $TaskName)
    Write-Host ("  - plugin bundle   {0}" -f $AvpiPath)
    Write-Host ("  - install folder  {0} (including config.json)" -f $InstallDir)
    Write-Host '  Node.js is left installed.'

    if (-not $DryRun -and -not $Force) {
        Write-Host ''
        $ans = Read-Host 'Type Y to continue'
        if ($ans -notmatch '^(y|yes)$') {
            Write-Result 'WARN' 'Cancelled. Nothing was removed.'
            Exit-Script 0
        }
    }

    $failed = $false

    Write-Host ''
    Write-Host 'Scheduled task and helper process' -ForegroundColor Cyan
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($DryRun) {
        if ($task) { Write-Result 'PLAN' ("Would stop and unregister task '{0}'." -f $TaskName) }
        else { Write-Result 'PLAN' ("Task '{0}' not found; nothing to unregister." -f $TaskName) }
        $n = @(Get-OurProcesses).Count
        Write-Result 'PLAN' ("Would stop {0} running helper process(es)." -f $n)
    } else {
        if ($task) {
            Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
            Write-Result 'OK' ("Stopped and removed task '{0}'." -f $TaskName)
        } else {
            Write-Result 'INFO' ("Task '{0}' was not registered." -f $TaskName)
        }
        $procs = @(Get-OurProcesses | Sort-Object { if ($_.Name -ieq 'wscript.exe') { 0 } else { 1 } })
        foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
        Write-Result 'OK' ("Stopped {0} helper process(es)." -f $procs.Count)
        Start-Sleep -Milliseconds 500
    }

    Write-Host ''
    Write-Host 'Plugin bundle' -ForegroundColor Cyan
    if (Test-Path -LiteralPath $AvpiPath) {
        if ($DryRun) {
            Write-Result 'PLAN' ("Would delete {0}" -f $AvpiPath)
        } else {
            try {
                Remove-Item -LiteralPath $AvpiPath -Force
                Write-Result 'OK' ("Deleted {0}" -f $AvpiPath)
            } catch {
                Write-Result 'FAIL' ("Could not delete {0}: {1} (Media Composer may have it open; close it and retry)" -f $AvpiPath, $_.Exception.Message)
                $failed = $true
            }
        }
    } else {
        Write-Result 'INFO' ("{0} not found." -f $AvpiPath)
    }

    Write-Host ''
    Write-Host 'Install folder' -ForegroundColor Cyan
    if (Test-Path -LiteralPath $InstallDir) {
        if ($DryRun) {
            Write-Result 'PLAN' ("Would delete {0}" -f $InstallDir)
        } else {
            try {
                Remove-Item -LiteralPath $InstallDir -Recurse -Force
                Write-Result 'OK' ("Deleted {0}" -f $InstallDir)
            } catch {
                Write-Result 'FAIL' ("Could not delete {0}: {1}" -f $InstallDir, $_.Exception.Message)
                $failed = $true
            }
        }
    } else {
        Write-Result 'INFO' ("{0} not found." -f $InstallDir)
    }

    Write-Host ''
    if ($DryRun) {
        Write-Host 'Dry run finished.' -ForegroundColor Magenta
    } elseif ($failed) {
        Write-Host 'Uninstall finished with errors (see above).' -ForegroundColor Yellow
        Exit-Script 2
    } else {
        Write-Host 'Uninstall finished. Restart Media Composer (or run "panelsdk reinit" in its Console, Ctrl+6) so the panel entry disappears.' -ForegroundColor Green
    }
    Exit-Script 0
} catch {
    Write-Result 'FAIL' ($_.Exception.Message)
    Exit-Script 1
}
