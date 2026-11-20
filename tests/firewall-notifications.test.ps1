$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot '..\client\firewall-notifications.ps1'
$powershell = Join-Path $PSHOME 'powershell.exe'
$journal = 'HKLM:\SOFTWARE\PC-Bridge'
$journalName = 'RestorePrivateFirewallNotifications'

function Get-Notifications {
    return (Get-NetFirewallProfile -Name Private -PolicyStore PersistentStore).NotifyOnListen.ToString()
}

function Test-Session([bool]$TerminateOwner, [string]$Initial, [switch]$Recover) {
    if ($Recover) {
        Set-NetFirewallProfile -Name Private -PolicyStore PersistentStore -NotifyOnListen False
        New-ItemProperty -LiteralPath $journal -Name $journalName -Value 1 -PropertyType DWord -Force | Out-Null
    } else {
        Set-NetFirewallProfile -Name Private -PolicyStore PersistentStore -NotifyOnListen $Initial
    }
    $session = [Guid]::NewGuid().ToString('N')
    $events = @{}
    $owner = $process = $null
    $errors = New-TemporaryFile
    try {
        foreach ($name in 'Ready', 'Stop', 'Settled', 'Failed') {
            $events[$name] = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::ManualReset,
                "Local\PCBridge.Firewall.$session.$name")
        }
        $owner = Start-Process $powershell -ArgumentList '-NoProfile -Command Start-Sleep -Seconds 120' -WindowStyle Hidden -PassThru
        $start = $owner.StartTime.ToUniversalTime().Ticks
        $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$helper`" -FirewallHelper -Session $session -OwnerProcessId $($owner.Id) -OwnerStarted $start"
        $process = Start-Process $powershell -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardError $errors.FullName
        if (-not $events.Ready.WaitOne(20000)) { throw 'The firewall helper did not start.' }
        if ((Get-Notifications) -ne 'False') { throw 'Firewall notifications were not muted.' }

        if ($TerminateOwner) {
            $owner.Kill()
            $owner.WaitForExit()
        } else {
            [void]$events.Stop.Set()
        }

        if (-not $events.Settled.WaitOne(20000) -or $events.Failed.WaitOne(0)) {
            throw 'The firewall helper failed to restore the setting.'
        }
        if ((Get-Notifications) -ne $Initial) { throw "The initial value $Initial was not restored." }
        if (Get-ItemProperty -LiteralPath $journal -Name $journalName -ErrorAction SilentlyContinue) {
            throw 'The restore journal was not cleared.'
        }
    } finally {
        if ($events.Stop) { [void]$events.Stop.Set() }
        if ($process) {
            if (-not $process.WaitForExit(5000)) { $process.Kill() }
            $process.Dispose()
        }
        if ($owner) {
            if (-not $owner.HasExited) { $owner.Kill() }
            $owner.Dispose()
        }
        foreach ($handle in $events.Values) { $handle.Dispose() }
        Get-Content -LiteralPath $errors.FullName | Write-Host
        Remove-Item -LiteralPath $errors.FullName
    }
}

$previous = Get-Notifications
try {
    Test-Session -TerminateOwner $false -Initial True
    Test-Session -TerminateOwner $true -Initial True
    Test-Session -TerminateOwner $false -Initial False
    Test-Session -TerminateOwner $false -Initial True -Recover
} finally {
    Set-NetFirewallProfile -Name Private -PolicyStore PersistentStore -NotifyOnListen $previous
}
Write-Host 'Windows firewall test mode verified.'
