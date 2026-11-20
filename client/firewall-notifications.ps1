param(
    [switch]$FirewallHelper,
    [ValidatePattern('^[0-9a-f]{32}$')][string]$Session,
    [int]$OwnerProcessId,
    [long]$OwnerStarted
)

$ErrorActionPreference = 'Stop'

function Get-EventName([string]$Name) {
    return "Local\PCBridge.Firewall.$Session.$Name"
}

function Invoke-FirewallHelper {
    $eventRights = [System.Security.AccessControl.EventWaitHandleRights]
    $mutex = $ready = $stop = $settled = $failed = $ownerProcess = $null
    $locked = $false
    try {
        $ready = [Threading.EventWaitHandle]::OpenExisting((Get-EventName Ready), $eventRights::Modify)
        $stop = [Threading.EventWaitHandle]::OpenExisting((Get-EventName Stop), $eventRights::Synchronize)
        $settled = [Threading.EventWaitHandle]::OpenExisting((Get-EventName Settled), $eventRights::Modify)
        $failed = [Threading.EventWaitHandle]::OpenExisting((Get-EventName Failed), $eventRights::Modify)
        $ownerProcess = [Diagnostics.Process]::GetProcessById($OwnerProcessId)
        if ($ownerProcess.StartTime.ToUniversalTime().Ticks -ne $OwnerStarted -or $ownerProcess.HasExited -or $stop.WaitOne(0)) {
            return
        }

        $mutex = [Threading.Mutex]::new($false, 'Global\PCBridge.PrivateFirewallNotifications')
        try {
            $locked = $mutex.WaitOne(0)
        } catch [Threading.AbandonedMutexException] {
            $locked = $true
        }
        if (-not $locked) {
            throw 'Es laeuft bereits ein PC-Bridge-Testmodus.'
        }

        Import-Module (Join-Path $PSHOME 'Modules\NetSecurity\NetSecurity.psd1')
        $journalPath = 'HKLM:\SOFTWARE\PC-Bridge'
        $journalName = 'RestorePrivateFirewallNotifications'
        $previous = Get-ItemProperty -LiteralPath $journalPath -Name $journalName -ErrorAction SilentlyContinue
        if ($previous) {
            # A helper terminated before its finally block could restore the setting.
            Set-NetFirewallProfile -Name Private -PolicyStore PersistentStore -NotifyOnListen True
            Remove-ItemProperty -LiteralPath $journalPath -Name $journalName
        }

        $restore = $false
        try {
            $effective = (Get-NetFirewallProfile -Name Private -PolicyStore ActiveStore).NotifyOnListen
            if ($effective -ne 'False') {
                $configured = (Get-NetFirewallProfile -Name Private -PolicyStore PersistentStore).NotifyOnListen
                if ($configured -ne 'True') {
                    throw 'Der Ausgangswert ist nicht lokal als True gesetzt und kann nicht sicher wiederhergestellt werden.'
                }

                # The journal is owned by administrators. Save it before changing the machine setting.
                if (-not (Test-Path -LiteralPath $journalPath)) {
                    New-Item -Path $journalPath | Out-Null
                }
                New-ItemProperty -LiteralPath $journalPath -Name $journalName -Value 1 -PropertyType DWord -Force | Out-Null
                $restore = $true
                Set-NetFirewallProfile -Name Private -PolicyStore PersistentStore -NotifyOnListen False
                if ((Get-NetFirewallProfile -Name Private -PolicyStore ActiveStore).NotifyOnListen -ne 'False') {
                    throw 'Eine Firewall-Richtlinie verhindert das Stummschalten.'
                }
            }

            [void]$ready.Set()
            # This helper has its own console. It can restore the setting after the client window is closed.
            while (-not $ownerProcess.HasExited -and -not $stop.WaitOne(250)) {}
        } finally {
            if ($restore) {
                Set-NetFirewallProfile -Name Private -PolicyStore PersistentStore -NotifyOnListen True
                if ((Get-NetFirewallProfile -Name Private -PolicyStore PersistentStore).NotifyOnListen -ne 'True') {
                    throw 'Die Firewall-Benachrichtigungen konnten nicht wiederhergestellt werden.'
                }
                Remove-ItemProperty -LiteralPath $journalPath -Name $journalName
            }
        }
    } catch {
        if ($failed) { [void]$failed.Set() }
        throw
    } finally {
        if ($locked) { $mutex.ReleaseMutex() }
        if ($settled) { [void]$settled.Set() }
        foreach ($handle in @($mutex, $ready, $stop, $settled, $failed, $ownerProcess)) {
            if ($handle) { $handle.Dispose() }
        }
    }
}

if ($FirewallHelper) {
    Invoke-FirewallHelper
    exit
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Starte PC-Bridge-Testmodus.cmd normal. Nur der Firewall-Helfer fordert Adminrechte an.'
}

$node = Get-Command node.exe -CommandType Application
$Session = [Guid]::NewGuid().ToString('N')
$rights = [System.Security.AccessControl.EventWaitHandleRights]
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$admins = [Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)
$security = [System.Security.AccessControl.EventWaitHandleSecurity]::new()
$security.AddAccessRule([System.Security.AccessControl.EventWaitHandleAccessRule]::new($identity.User, $rights::FullControl, $allow))
$security.AddAccessRule([System.Security.AccessControl.EventWaitHandleAccessRule]::new($admins, ($rights::Modify -bor $rights::Synchronize), $allow))

$events = @{}
$started = $false
$exitCode = 1
try {
    foreach ($name in 'Ready', 'Stop', 'Settled', 'Failed') {
        $created = $false
        $events[$name] = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::ManualReset, (Get-EventName $name), [ref]$created, $security)
        if (-not $created) { throw 'Die Testmodus-Sitzung konnte nicht eindeutig erstellt werden.' }
    }

    $owner = [Diagnostics.Process]::GetCurrentProcess()
    $ownerStarted = $owner.StartTime.ToUniversalTime().Ticks
    Write-Host 'Testmodus: Windows fragt einmal nach Adminrechten fuer Firewall-Benachrichtigungen im privaten Profil.'
    $arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$PSCommandPath`" -FirewallHelper -Session $Session -OwnerProcessId $PID -OwnerStarted $ownerStarted"
    Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden
    $started = $true
    $wait = [Threading.WaitHandle[]]@($events.Ready, $events.Settled)
    if ([Threading.WaitHandle]::WaitAny($wait, 20000) -ne 0) {
        throw 'Der Firewall-Testmodus konnte nicht aktiviert werden. Pruefe die Adminfreigabe bzw. die Firewall-Richtlinie.'
    }

    Write-Host 'Testmodus aktiv. Nach Ende der Sitzung stellt der Helfer den Ausgangswert wieder her.'
    & $node.Source (Join-Path $PSScriptRoot 'pc-bridge.mjs')
    $exitCode = $LASTEXITCODE
} finally {
    if ($started) {
        [void]$events.Stop.Set()
        if (-not $events.Settled.WaitOne(10000) -or $events.Failed.WaitOne(0)) {
            Write-Warning 'Der Firewall-Helfer hat keinen erfolgreichen Abschluss gemeldet. Siehe Windows-Anleitung zur Wiederherstellung.'
            $exitCode = 1
        }
    }
    foreach ($handle in $events.Values) {
        $handle.Dispose()
    }
}
exit $exitCode
