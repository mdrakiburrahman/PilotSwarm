#Requires -Version 7.0
<#
.SYNOPSIS
Resets this Windows host for native Ubuntu 24.04 WSL development.
.DESCRIPTION
DESTRUCTIVE: unregisters EVERY WSL distribution, removes Docker Desktop and its
exact data directories, adds Defender exclusions and replaces global .wslconfig.
Back up source and WSL data outside WSL first. Run elevated in PowerShell 7.
DryRun is a portable, read-free plan; PreflightOnly inventories the actual host.
With no arguments, choose the VHD drive and proceed with the reset.
.EXAMPLE
pwsh -File .\dev\bootstrap-dev-env.ps1
.EXAMPLE
pwsh -File .\dev\bootstrap-dev-env.ps1 -VhdPath D:\VHD\PilotSwarm -DryRun
.EXAMPLE
pwsh -File .\dev\bootstrap-dev-env.ps1 -VhdPath D:\VHD\PilotSwarm -PreflightOnly
.EXAMPLE
pwsh -File .\dev\bootstrap-dev-env.ps1 -VhdPath D:\VHD\PilotSwarm -FullReset
#>
[CmdletBinding()]
param(
    [string] $VhdPath,
    [switch] $FullReset,
    [switch] $DryRun,
    [switch] $PreflightOnly,
    [switch] $AllowLowResources
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-Checked {
    param([string] $Executable, [string[]] $Arguments, [int[]] $AllowedExitCodes = @(0))
    & $Executable @Arguments
    if ($LASTEXITCODE -notin $AllowedExitCodes) {
        throw "$Executable failed with exit code $LASTEXITCODE (arguments: $($Arguments -join ' '))."
    }
}

function Get-Distros {
    $output = @(Invoke-Checked wsl.exe @('--list', '--quiet'))
    return @($output | ForEach-Object { "$_".Replace("`0", '').Trim() } | Where-Object { $_ })
}

function Get-DockerDesktopPackages {
    $roots = @(
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
    )
    foreach ($root in $roots) {
        if (Test-Path -LiteralPath $root) {
            Get-ChildItem -LiteralPath $root | Get-ItemProperty | Where-Object {
                $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -eq 'Docker Desktop'
            }
        }
    }
}

function Assert-NoReparsePoint {
    param([string] $Path, [switch] $CheckDescendants)
    $item = Get-Item -LiteralPath $Path -Force
    while ($null -ne $item) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Refusing a junction/symlink path: $Path"
        }
        $item = $item.Parent
    }
    if ($CheckDescendants -and @(Get-ChildItem -LiteralPath $Path -Force -Recurse |
        Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) {
        throw "Refusing to recursively remove a directory containing junctions/symlinks: $Path"
    }
}

function Select-VhdPath {
    $drives = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' |
        Sort-Object -Property FreeSpace -Descending)
    if (-not $drives.Count) { throw 'No local fixed drives found to host the WSL VHD.' }
    Write-Host 'Choose a drive to store the WSL VHD (at least 50GB free recommended):'
    for ($i = 0; $i -lt $drives.Count; $i++) {
        Write-Host ('  [{0}] {1}\VHD\PilotSwarm ({2}GB free)' -f
            ($i + 1), $drives[$i].DeviceID, [math]::Floor($drives[$i].FreeSpace / 1GB))
    }
    do {
        $pick = Read-Host "Pick a drive number [1-$($drives.Count)]"
        $number = 0
    } while (-not [int]::TryParse($pick, [ref]$number) -or $number -lt 1 -or $number -gt $drives.Count)
    return "$($drives[$number - 1].DeviceID)\VHD\PilotSwarm"
}

function Clear-VhdDirectory {
    param([string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    if ($Path -notmatch '^[A-Za-z]:\\VHD\\PilotSwarm$') {
        throw 'Automatic VHD deletion is restricted to <drive>:\VHD\PilotSwarm. Choose that dedicated directory.'
    }
    Assert-NoReparsePoint $Path -CheckDescendants
    Write-Host "Deleting VHD destination: $Path"
    Remove-Item -LiteralPath $Path -Recurse -Force
}

try {
    if (-not $PSBoundParameters.ContainsKey('FullReset') -and -not $DryRun -and -not $PreflightOnly) {
        $FullReset = $true
    }
    if (-not $VhdPath) {
        if ($DryRun) { $VhdPath = 'C:\VHD\PilotSwarm' }
        else {
            if (-not $IsWindows) { throw 'Windows is required.' }
            $pickerIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
            $pickerPrincipal = [Security.Principal.WindowsPrincipal]::new($pickerIdentity)
            if (-not $pickerPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
                throw 'Run PowerShell 7 as Administrator.'
            }
            $VhdPath = Select-VhdPath
        }
    }
    # Validate lexically before the portable dry-run; never evaluate a user-supplied command.
    if ($VhdPath -notmatch '^[A-Za-z]:\\[^:*?"<>|]+$' -or $VhdPath -match '[\r\n]' -or
        @($VhdPath.Split('\') | Where-Object { $_ -in @('.', '..') }).Count) {
        throw 'VhdPath must be an absolute local drive subdirectory, not a root, UNC path or traversal.'
    }
    if ($DryRun -and $PreflightOnly) { throw 'Choose DryRun or PreflightOnly, not both.' }
    if (-not $DryRun -and -not $PreflightOnly -and -not $FullReset) {
        throw 'Reset disabled: choose -PreflightOnly or -DryRun for read-only operation.'
    }
    Write-Host "DESTRUCTIVE PLAN: ALL WSL distributions and Docker Desktop data will be deleted."
    Write-Host "Ubuntu-24.04 VHD destination: $VhdPath"
    Write-Host 'Defender: exclude chosen VHD path and WSL/Docker processes (reduces malware scanning).'
    Write-Host 'Global .wslconfig: back up existing file, replace WSL2 memory/CPU/swap/NAT settings.'
    Write-Host 'Install/update: WSL >=2.4.4, Ubuntu-24.04, Git Credential Manager, VS Code WSL/Containers extensions.'
    if ($DryRun) {
        Write-Host 'DRY RUN: no host inventory, commands, installations, writes or reset performed.'
        Write-Host 'Actual preflight requires Windows, PS7/admin, wsl.exe, winget.exe, code, Defender, virtualization and 50GB free.'
        return
    }
    if (-not $IsWindows) { throw 'Windows is required.' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run PowerShell 7 as Administrator.'
    }
    foreach ($command in @('wsl.exe', 'winget.exe', 'code', 'Get-MpPreference', 'Add-MpPreference')) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Missing prerequisite: $command" }
    }
    $VhdPath = [IO.Path]::GetFullPath($VhdPath).TrimEnd('\')
    $drive = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($VhdPath.Substring(0, 2))'"
    if (-not $drive -or $drive.DriveType -ne 3) { throw 'VhdPath must be on a local fixed drive.' }
    $freeGB = [math]::Floor($drive.FreeSpace / 1GB)
    $computer = Get-CimInstance Win32_ComputerSystem
    $cores = [Environment]::ProcessorCount
    $memoryGB = [math]::Floor($computer.TotalPhysicalMemory / 1GB)
    Write-Host "Preflight: $cores CPUs, ${memoryGB}GB RAM, ${freeGB}GB free on $($drive.DeviceID)"
    if (($freeGB -lt 50 -or $cores -lt 8) -and -not $AllowLowResources) {
        throw 'Recommend >=8 CPUs and >=50GB free. Use -AllowLowResources to explicitly accept this risk.'
    }
    if ($memoryGB -lt 4) { throw 'At least 4GB physical memory is required.' }
    $feature = Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform
    if ($feature.State -ne 'Enabled') {
        throw 'Enable VirtualMachinePlatform and reboot before resetting this host.'
    }
    if (-not $computer.HypervisorPresent -and
        -not @(Get-CimInstance Win32_Processor | Where-Object VirtualizationFirmwareEnabled).Count) {
        throw 'Enable hardware virtualization in firmware and reboot before proceeding.'
    }
    $versionRaw = @(Invoke-Checked wsl.exe @('--version'))
    $versionMatch = [regex]::Match(($versionRaw -join "`n").Replace("`0", ''), '\d+\.\d+\.\d+')
    if (-not $versionMatch.Success) { throw 'Cannot determine WSL version. Update WSL before resetting.' }
    Write-Host "WSL installed version: $($versionMatch.Value) (will update before any reset)"
    $distros = @(Get-Distros)
    Write-Host "EXACT WSL INVENTORY ($($distros.Count)): $($distros -join ', ')"
    $desktopPackages = @(Get-DockerDesktopPackages)
    Write-Host "Docker Desktop installed registrations: $($desktopPackages.Count)"
    $null = Get-MpPreference
    if (Test-Path -LiteralPath $VhdPath) {
        Assert-NoReparsePoint $VhdPath -CheckDescendants
        if ($VhdPath -notmatch '^[A-Za-z]:\\VHD\\PilotSwarm$') {
            throw 'Automatic VHD deletion is restricted to <drive>:\VHD\PilotSwarm. Choose that dedicated directory.'
        }
    } else {
        $parent = [IO.DirectoryInfo]::new($VhdPath).Parent
        while ($parent -and -not (Test-Path -LiteralPath $parent.FullName)) { $parent = $parent.Parent }
        if ($parent) { Assert-NoReparsePoint $parent.FullName }
    }
    $dockerRoots = @(
        (Join-Path $env:ProgramFiles 'Docker\Docker'),
        (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop')
    )
    $dockerDataPaths = @(
        (Join-Path $env:ProgramData 'Docker'),
        (Join-Path $env:ProgramData 'DockerDesktop'),
        (Join-Path $env:LOCALAPPDATA 'Docker'),
        (Join-Path $env:LOCALAPPDATA 'Docker Desktop'),
        (Join-Path $env:APPDATA 'Docker'),
        (Join-Path $env:APPDATA 'Docker Desktop')
    )
    foreach ($path in @($dockerRoots) + @($dockerDataPaths)) {
        if (Test-Path -LiteralPath $path) { Assert-NoReparsePoint $path -CheckDescendants }
    }
    if ($PreflightOnly) { Write-Host 'Preflight passed; no host changes performed.'; return }

    # Check update support and version before deleting any data.
    Invoke-Checked wsl.exe @('--update')
    $updatedVersion = (@(Invoke-Checked wsl.exe @('--version')) -join "`n").Replace("`0", '')
    $updatedMatch = [regex]::Match($updatedVersion, '\d+\.\d+\.\d+')
    if (-not $updatedMatch.Success -or [version]$updatedMatch.Value -lt [version]'2.4.4') {
        throw 'WSL >=2.4.4 is required for --location. No reset performed.'
    }
    $currentDistros = @(Get-Distros)
    if ((($distros | Sort-Object) -join "`0") -cne (($currentDistros | Sort-Object) -join "`0")) {
        throw 'WSL inventory changed since preflight. Rerun preflight; no reset performed.'
    }
    # Stop only PIDs whose executable is inside an exact Docker Desktop installation.
    foreach ($process in @(Get-CimInstance Win32_Process)) {
        if ($process.ExecutablePath -and @($dockerRoots | Where-Object {
            $process.ExecutablePath.StartsWith("$_\", [StringComparison]::OrdinalIgnoreCase)
        }).Count) {
            Stop-Process -Id $process.ProcessId -Force
        }
    }
    if ($desktopPackages.Count) {
        Invoke-Checked winget.exe @('uninstall', '--exact', '--id', 'Docker.DockerDesktop',
            '--silent', '--disable-interactivity', '--accept-source-agreements')
        if (@(Get-DockerDesktopPackages).Count) { throw 'Docker Desktop remains installed; reset stopped.' }
    }
    Invoke-Checked wsl.exe @('--shutdown')
    # Docker's uninstaller can unregister its own distributions; enumerate again.
    foreach ($distro in @(Get-Distros)) {
        if ($distro -notin $distros) { throw "Unconfirmed new distribution: $distro. Reset stopped." }
        Write-Host "Unregistering: $distro"
        Invoke-Checked wsl.exe @('--unregister', $distro)
    }
    Clear-VhdDirectory $VhdPath
    foreach ($path in @($dockerRoots) + @($dockerDataPaths)) {
        if (Test-Path -LiteralPath $path) {
            Assert-NoReparsePoint $path -CheckDescendants
            Remove-Item -LiteralPath $path -Recurse -Force
        }
    }
    [IO.Directory]::CreateDirectory($VhdPath) | Out-Null
    $preferences = Get-MpPreference
    if ($VhdPath -notin @($preferences.ExclusionPath)) { Add-MpPreference -ExclusionPath $VhdPath }
    foreach ($process in @('wsl.exe', 'wslhost.exe', 'wslservice.exe', 'vmmem', 'vmmemWSL',
        'dockerd', 'containerd', 'containerd-shim-runc-v2', 'com.docker.backend.exe')) {
        if ($process -notin @($preferences.ExclusionProcess)) { Add-MpPreference -ExclusionProcess $process }
    }
    $wslConfig = Join-Path $env:USERPROFILE '.wslconfig'
    if (Test-Path -LiteralPath $wslConfig) {
        $backup = "$wslConfig.pilotswarm-backup-$([Guid]::NewGuid().ToString('N'))"
        Copy-Item -LiteralPath $wslConfig -Destination $backup
        Write-Host "Previous global WSL configuration backed up to $backup"
    }
    $swapGB = [math]::Floor($memoryGB / 4)
    "[wsl2]`nmemory=${memoryGB}GB`nprocessors=$cores`nswap=${swapGB}GB`nnetworkingMode=NAT`n" |
        Set-Content -LiteralPath $wslConfig -Encoding utf8NoBOM
    Invoke-Checked wsl.exe @('--shutdown')
    Invoke-Checked winget.exe @('install', '--exact', '--id', 'Git.GCM', '--silent',
        '--disable-interactivity', '--accept-package-agreements', '--accept-source-agreements', '--no-upgrade') `
        -AllowedExitCodes @(0, -1978335189, -1978335135) # WinGet: no applicable update / package already installed.
    $extensions = @(Invoke-Checked code @('--list-extensions'))
    if ('Microsoft.wavework' -in $extensions) {
        Invoke-Checked code @('--uninstall-extension', 'Microsoft.wavework')
    }
    foreach ($extension in @('ms-vscode-remote.remote-wsl', 'ms-vscode-remote.remote-containers')) {
        Invoke-Checked code @('--install-extension', $extension)
    }
    $sshDirectory = Join-Path $env:USERPROFILE '.ssh'
    $knownHosts = Join-Path $sshDirectory 'known_hosts'
    New-Item -ItemType Directory -Path $sshDirectory -Force | Out-Null
    if (-not (Test-Path -LiteralPath $knownHosts) -or (Get-Item -LiteralPath $knownHosts).Length -eq 0) {
        '# PilotSwarm: nonempty known_hosts for VS Code Remote Containers.' |
            Set-Content -LiteralPath $knownHosts -Encoding utf8NoBOM
    }
    Invoke-Checked icacls.exe @($knownHosts, '/inheritance:r', '/grant:r', "$($identity.Name):F")
    Invoke-Checked wsl.exe @('--set-default-version', '2')
    Invoke-Checked wsl.exe @('--install', '--distribution', 'Ubuntu-24.04', '--location', $VhdPath, '--no-launch')
    if ('Ubuntu-24.04' -notin @(Get-Distros)) { throw 'Ubuntu-24.04 installation did not register; reboot may be required.' }
    Invoke-Checked wsl.exe @('--set-default', 'Ubuntu-24.04')
    Write-Host 'Reset complete. Entering Ubuntu-24.04; finish Linux user setup when prompted.'
    Write-Host 'Clone into /workspaces/PilotSwarm (never /mnt/c), then run bash dev/bootstrap-dev-env.sh.'
    Invoke-Checked wsl.exe @('--distribution', 'Ubuntu-24.04')
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
