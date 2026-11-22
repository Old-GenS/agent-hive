# install.ps1 - install Agent Hive inside WSL2 on Windows 11, with no Linux prompts.
#
#   irm https://raw.githubusercontent.com/ogsapps/agent-hive/main/install.ps1 | iex
#
# The `irm | iex` form cannot pass parameters, so the matching environment variables work too:
#   HIVE_WSL_DISTRO   the WSL distro to create or reuse (default agent-hive)
#   HIVE_WSL_USER     the Linux user inside it (default your Windows user name, sanitized)
#   HIVE_UNINSTALL=1  same as -Uninstall
#   HIVE_INSTALL_CLI_URL  install-cli.sh URL (for testing)
#
# The distro is dedicated to hive. This script never touches other distros; -Uninstall removes it
# and the hive command from Windows.

[CmdletBinding()]
param(
    [string]$Distro = $(if ($env:HIVE_WSL_DISTRO) { $env:HIVE_WSL_DISTRO } else { 'agent-hive' }),
    [string]$User = $(if ($env:HIVE_WSL_USER) { $env:HIVE_WSL_USER } else {
            $name = [Environment]::UserName.ToLowerInvariant() -replace '[^a-z0-9_-]', ''
            if ($name -match '^[a-z_][a-z0-9_-]{0,31}$') { $name } else { 'hive' }
        }),
    [switch]$Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Both names end up in Linux commands, so only plain names are accepted.
if ($User -notmatch '^[a-z_][a-z0-9_-]{0,31}$') {
    throw "hive: '$User' is not a valid Linux user name (lowercase letters, digits, _ and -; starting with a letter or _)"
}
if ($Distro -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
    throw "hive: '$Distro' is not a valid WSL distro name (letters, digits, . _ and -)"
}

# Text piped into wsl.exe: UTF-8 without a byte-order mark (Windows PowerShell 5.1 defaults to
# ASCII, which would turn non-ASCII password characters into '?'). PowerShell also ends each piped
# line with CRLF, so every receiving command strips the CR on the Linux side.
$OutputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false

$InstallCliUrl = 'https://raw.githubusercontent.com/ogsapps/agent-hive/main/install-cli.sh'
if ($env:HIVE_INSTALL_CLI_URL) { $InstallCliUrl = $env:HIVE_INSTALL_CLI_URL }

$BinDir = Join-Path -Path $env:LOCALAPPDATA -ChildPath 'agent-hive\bin'
$HiveCmd = Join-Path -Path $BinDir -ChildPath 'hive.cmd'
$WslConfig = Join-Path -Path $env:USERPROFILE -ChildPath '.wslconfig'
$WslConfigBackup = $WslConfig + '.hive-backup'
$LASTEXITCODE = 0

function Write-Step {
    param([Parameter(Mandatory = $true)][string]$Text)
    Write-Host "==> $Text"
}

function Write-Note {
    param([Parameter(Mandatory = $true)][string]$Text)
    Write-Host "    $Text"
}

# One short line describing the command, for error messages.
function Format-Command {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @()
    )
    return $FilePath + ' ' + ($ArgumentList -join ' ')
}

# Run one external command and check its exit code. Output is captured unless -Attached lets it go
# straight to the console. With -AllowFailure the caller gets the exit code instead of an error.
function Invoke-Program {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [switch]$AllowFailure,
        [switch]$Attached
    )
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($Attached) {
            & $FilePath @ArgumentList
            $lines = @()
        } else {
            $lines = @(& $FilePath @ArgumentList 2>&1)
        }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0 -and -not $AllowFailure) {
        Write-Host ''
        Write-Host "hive: this step failed: $(Format-Command -FilePath $FilePath -ArgumentList $ArgumentList)"
        $detail = ($lines | ForEach-Object { "$_" }) -join ' '
        if ($detail) {
            Write-Host "hive: $detail"
        }
        throw "exit code $code"
    }
    return @{ ExitCode = $code; Output = $lines }
}

function Test-WslPresent {
    if (-not (Get-Command -Name wsl.exe -ErrorAction SilentlyContinue)) {
        return $false
    }
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & wsl.exe --status *> $null
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    return ($code -eq 0)
}

# The registered distro names. WSL prints UTF-16 on older builds, so ask for UTF-8 and also strip
# any NUL characters left by a UTF-16 listing.
function Get-WslDistro {
    $previous = $env:WSL_UTF8
    $env:WSL_UTF8 = '1'
    try {
        $result = Invoke-Program -FilePath 'wsl.exe' -ArgumentList @('--list', '--quiet') -AllowFailure
    } finally {
        $env:WSL_UTF8 = $previous
    }
    $names = @()
    foreach ($line in $result.Output) {
        $text = ("$line" -replace "`0", '').Trim()
        if ($text) { $names += $text }
    }
    return $names
}

# Set Key=Value in [Section] of an INI-style file text (wsl.conf, .wslconfig), keeping everything
# else, and adding the section when it is missing.
function Write-IniValue {
    param(
        [Parameter(Mandatory = $true)][string]$Section,
        [Parameter(Mandatory = $true)][string]$Key,
        [Parameter(Mandatory = $true)][string]$Value,
        [string]$Existing = ''
    )
    $lines = New-Object System.Collections.Generic.List[string]
    $raw = @()
    if ($Existing.Trim()) { $raw = $Existing -split "`r?`n" }
    $wanted = $Section.ToLowerInvariant()
    $current = ''
    $sectionSeen = $false
    $valueSet = $false
    $keyPattern = '^' + [regex]::Escape($Key) + '\s*='
    foreach ($line in $raw) {
        $trimmed = $line.Trim()
        if ($trimmed -match '^\[(.+)\]$') {
            $current = $Matches[1].Trim().ToLowerInvariant()
            if ($current -eq $wanted) { $sectionSeen = $true }
            $lines.Add($trimmed)
            continue
        }
        if ($current -eq $wanted -and $trimmed -match $keyPattern) {
            $lines.Add("$Key=$Value")
            $valueSet = $true
            continue
        }
        $lines.Add($line)
    }
    if (-not $valueSet) {
        if (-not $sectionSeen) {
            if ($lines.Count -gt 0) { $lines.Add('') }
            $lines.Add("[$Section]")
            $lines.Add("$Key=$Value")
        } else {
            $heading = '[' + $Section + ']'
            for ($i = 0; $i -lt $lines.Count; $i++) {
                if ($lines[$i].Trim().ToLowerInvariant() -eq $heading.ToLowerInvariant()) {
                    $lines.Insert($i + 1, "$Key=$Value")
                    break
                }
            }
        }
    }
    return ($lines -join "`n")
}

function Invoke-Uninstall {
    param(
        [Parameter(Mandatory = $true)][string]$DistroName,
        [Parameter(Mandatory = $true)][string]$BinPath,
        [Parameter(Mandatory = $true)][string]$ConfigBackup
    )
    Write-Step "Uninstalling Agent Hive ('$DistroName' and the hive command)"
    Write-Host "hive: this deletes the WSL distro '$DistroName' and everything in it: projects, keys and runs."
    $answer = Read-Host -Prompt "Remove '$DistroName' and the hive command? [y/N]"
    if ($answer -notmatch '^[Yy]') {
        Write-Note 'Nothing was changed.'
        return
    }
    $result = Invoke-Program -FilePath 'wsl.exe' -ArgumentList @('--unregister', $DistroName) -AllowFailure
    if ($result.ExitCode -ne 0) {
        Write-Note "the distro was not registered (or could not be removed); continuing with the hive command"
    }
    if (Test-Path -Path $BinPath -PathType Container) {
        Remove-Item -Path $BinPath -Recurse -Force
        Write-Note "removed $BinPath"
    }
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $userPath) { $userPath = '' }
    $kept = @($userPath -split ';' | Where-Object { $_ -and ($_ -ne $BinPath) })
    [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'User')
    Write-Note 'removed the hive folder from your user PATH'
    if (Test-Path -Path $ConfigBackup -PathType Leaf) {
        Write-Note ".wslconfig was left alone; its backup from this install is $ConfigBackup"
    } else {
        Write-Note '.wslconfig was left alone.'
    }
    Write-Step 'Agent Hive is uninstalled'
}

# The script can't ask for a Linux password twice through `irm | iex`; env vars cover the rest.
$remove = [bool]$Uninstall -or ($env:HIVE_UNINSTALL -eq '1')

if ($User -notmatch '^[a-z0-9_-]+$') {
    throw "hive: the Linux user name '$User' may only contain a-z, 0-9, '_' and '-'"
}
if ($Distro -notmatch '^[A-Za-z0-9._-]+$') {
    throw "hive: the WSL distro name '$Distro' may only contain A-Z, a-z, 0-9, '.', '_' and '-'"
}

if ($remove) {
    Invoke-Uninstall -DistroName $Distro -BinPath $BinDir -ConfigBackup $WslConfigBackup
    exit 0
}

Write-Step 'Checking WSL'
if (-not (Test-WslPresent)) {
    Write-Host 'hive: Windows Subsystem for Linux (WSL) is needed, and it is not installed yet.'
    Write-Host 'hive: run this once in an Administrator PowerShell, then restart Windows:'
    Write-Host '    wsl --install --no-distribution'
    Write-Host 'hive: after the restart, run this installer again.'
    exit 1
}
$update = Invoke-Program -FilePath 'wsl.exe' -ArgumentList @('--update') -AllowFailure
if ($update.ExitCode -ne 0) {
    Write-Note "wsl --update failed (exit code $($update.ExitCode)); using the installed WSL"
}

Write-Step "Preparing the WSL distro '$Distro'"
$distroPresent = @(Get-WslDistro) -contains $Distro
if (-not $distroPresent) {
    Write-Note 'installing Ubuntu 24.04 as a dedicated distro (one time)'
    Invoke-Program -FilePath 'wsl.exe' -ArgumentList @('--install', 'Ubuntu-24.04', '--name', $Distro, '--no-launch') | Out-Null
    $distroPresent = @(Get-WslDistro) -contains $Distro
    if (-not $distroPresent) {
        Write-Host "hive: WSL did not register the distro '$Distro'."
        Write-Host "hive: try: wsl --install Ubuntu-24.04 --name $Distro --no-launch"
        exit 1
    }
} else {
    Write-Note 'reusing the existing distro'
}

Write-Step "Setting up the Linux user '$User'"
Invoke-Program -FilePath 'wsl.exe' -ArgumentList @('-d', $Distro, '-u', 'root', '--', 'sh', '-c', 'groupadd -f kvm') | Out-Null
$userCheck = Invoke-Program -FilePath 'wsl.exe' -ArgumentList @('-d', $Distro, '-u', 'root', '--', 'sh', '-c', "id -u $User >/dev/null 2>&1") -AllowFailure
$createdUser = $false
if ($userCheck.ExitCode -ne 0) {
    Invoke-Program -FilePath 'wsl.exe' -ArgumentList @('-d', $Distro, '-u', 'root', '--', 'sh', '-c', "useradd -m -s /bin/bash -G sudo,kvm $User") | Out-Null
    $createdUser = $true
} else {
    Invoke-Program -FilePath 'wsl.exe' -ArgumentList @('-d', $Distro, '-u', 'root', '--', 'sh', '-c', "usermod -aG kvm,sudo $User") | Out-Null
}

if ($createdUser) {
    Write-Step "Setting a password for '$User' (used by sudo inside WSL)"
    Write-Note 'the password stays in WSL; it is sent over standard input, never on a command line'
    $first = Read-Host -AsSecureString -Prompt "New password for $User in WSL"
    $second = Read-Host -AsSecureString -Prompt 'Repeat the password'
    $credential = New-Object -TypeName System.Management.Automation.PSCredential -ArgumentList 'hive', $first
    $plainFirst = $credential.GetNetworkCredential().Password
    $credential = New-Object -TypeName System.Management.Automation.PSCredential -ArgumentList 'hive', $second
    $plainSecond = $credential.GetNetworkCredential().Password
    if ($plainFirst -ne $plainSecond) {
        throw "hive: the passwords did not match; run the installer again"
    }
    if (-not $plainFirst) {
        throw "hive: the password is empty; run the installer again"
    }
    $pair = $User + ':' + $plainFirst
    $plainFirst = ''
    $plainSecond = ''
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $pair | wsl.exe -d $Distro -u root -- sh -c "tr -d '\r' | chpasswd"
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0) {
        throw "hive: setting the Linux password failed (exit code $code)"
    }
}

Write-Step 'Configuring /etc/wsl.conf (systemd and the default user)'
$wslConfResult = Invoke-Program -FilePath 'wsl.exe' -ArgumentList @('-d', $Distro, '-u', 'root', '--', 'cat', '/etc/wsl.conf') -AllowFailure
$wslConf = ''
if ($wslConfResult.ExitCode -eq 0) {
    $wslConf = (($wslConfResult.Output | ForEach-Object { "$_" }) -join "`n")
}
$wslConf = Write-IniValue -Existing $wslConf -Section 'boot' -Key 'systemd' -Value 'true'
$wslConf = Write-IniValue -Existing $wslConf -Section 'user' -Key 'default' -Value $User
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    $wslConf | wsl.exe -d $Distro -u root -- sh -c "tr -d '\r' > /etc/wsl.conf"
    $code = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previous
}
if ($code -ne 0) {
    throw "hive: writing /etc/wsl.conf failed (exit code $code)"
}

Write-Step 'Installing passt, gh, wslu, git, curl and ca-certificates (one time)'
Invoke-Program -FilePath 'wsl.exe' -ArgumentList @('-d', $Distro, '-u', 'root', '--', 'sh', '-c', 'apt-get update') | Out-Null
Invoke-Program -FilePath 'wsl.exe' -ArgumentList @('-d', $Distro, '-u', 'root', '--', 'sh', '-c', 'DEBIAN_FRONTEND=noninteractive apt-get install -y passt gh wslu git curl ca-certificates') | Out-Null

Write-Step 'Restarting the distro so the group and wsl.conf take effect'
Invoke-Program -FilePath 'wsl.exe' -ArgumentList @('--terminate', $Distro) | Out-Null

Write-Step 'Checking that /dev/kvm is usable'
$kvm = Invoke-Program -FilePath 'wsl.exe' -ArgumentList @('-d', $Distro, '-u', $User, '--', 'sh', '-c', 'test -r /dev/kvm && test -w /dev/kvm') -AllowFailure
if ($kvm.ExitCode -ne 0) {
    Write-Note '/dev/kvm is missing or not readable by the user.'
    Write-Note 'enabling nested virtualization in %UserProfile%\.wslconfig'
    if (Test-Path -Path $WslConfig -PathType Leaf) {
        Copy-Item -Path $WslConfig -Destination $WslConfigBackup -Force
        Write-Note "kept a backup at $WslConfigBackup"
    }
    $configText = ''
    if (Test-Path -Path $WslConfig -PathType Leaf) {
        $configText = Get-Content -Path $WslConfig -Raw
        if (-not $configText) { $configText = '' }
    }
    $newConfig = Write-IniValue -Existing $configText -Section 'wsl2' -Key 'nestedVirtualization' -Value 'true'
    [System.IO.File]::WriteAllText($WslConfig, $newConfig + "`n")
    Invoke-Program -FilePath 'wsl.exe' -ArgumentList @('--shutdown') | Out-Null
    $attempt = 0
    while ($attempt -lt 10 -and $kvm.ExitCode -ne 0) {
        $attempt = $attempt + 1
        Start-Sleep -Seconds 2
        $kvm = Invoke-Program -FilePath 'wsl.exe' -ArgumentList @('-d', $Distro, '-u', $User, '--', 'sh', '-c', 'test -r /dev/kvm && test -w /dev/kvm') -AllowFailure
    }
    if ($kvm.ExitCode -ne 0) {
        Write-Host 'hive: /dev/kvm is still missing after enabling nested virtualization.'
        Write-Host 'hive: virtualization is probably off in the BIOS/UEFI, or the CPU does not support it.'
        Write-Host 'hive: to back out, remove the distro with:'
        Write-Host "hive:   wsl --unregister $Distro"
        exit 1
    }
    Write-Note '/dev/kvm is available now'
}

Write-Step 'Installing the hive CLI inside WSL (the VM filesystem downloads once)'
$installCommand = 'curl -fsSL ' + $InstallCliUrl + ' | sh'
$installResult = Invoke-Program -FilePath 'wsl.exe' -ArgumentList @('-d', $Distro, '-u', $User, '--cd', '~', '--', 'sh', '-c', $installCommand) -AllowFailure -Attached
if ($installResult.ExitCode -ne 0) {
    Write-Host "hive: installing hive inside WSL failed (exit code $($installResult.ExitCode))."
    Write-Host "hive: the command was: wsl -d $Distro -u $User -- sh -c '$installCommand'"
    exit 1
}

Write-Step 'Adding the hive command to Windows'
$cmdLines = @(
    '@echo off',
    "wsl.exe -d $Distro --cd ~ -- /home/$User/.local/bin/hive %*"
)
if (-not (Test-Path -Path $BinDir -PathType Container)) {
    New-Item -ItemType Directory -Path $BinDir | Out-Null
}
Set-Content -Path $HiveCmd -Value $cmdLines -Encoding ASCII
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
$pathParts = @($userPath -split ';' | Where-Object { $_ })
if ($pathParts -notcontains $BinDir) {
    if ($userPath.Trim()) {
        $newPath = $userPath.TrimEnd(';') + ';' + $BinDir
    } else {
        $newPath = $BinDir
    }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Note "added $BinDir to your user PATH"
}
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$env:Path = $machinePath + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')

Write-Step 'Done'
Write-Host ''
Write-Host "hive is installed in the WSL distro '$Distro'. In a new terminal:"
Write-Host '  hive doctor                      check KVM, pasta and libkrun'
Write-Host '  hive keys add openrouter         or deepseek, zai, anthropic, openai'
Write-Host "  wsl -d $Distro -- gh auth login  for GitHub: new projects, pushes, pull requests"
Write-Host '  hive serve                       web UI at http://127.0.0.1:8080/ui/ in your browser'
Write-Host ''
Write-Host "Keep projects in the Linux home folder, not under C:\ (much faster)."
Write-Host "From Explorer: \\wsl$\$Distro\home\$User"
Write-Host ''
Write-Host 'To remove it later:'
Write-Host '  irm https://raw.githubusercontent.com/ogsapps/agent-hive/main/install.ps1 | iex'
Write-Host '  (with the environment variable HIVE_UNINSTALL=1 set, or run the file with -Uninstall)'
