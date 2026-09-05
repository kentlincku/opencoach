# verify-windows-product-e2e.ps1
# Automated packaged-App UI driver and product completeness verifier for Windows Desktop Lite

[CmdletBinding()]
param(
    [switch]$ContractOnly,
    [switch]$LiveLocalLlm,
    [switch]$CoreProduct,
    [switch]$Resilience,
    [switch]$AuthContracts,
    [switch]$NativeVoice,
    [Parameter(Mandatory = $true)][string]$ExpectedCodeSha,
    [string]$ExecutablePath = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

function Get-FreeTcpPort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    }
    finally {
        $listener.Stop()
    }
}

function Get-ProcessTreeIds([int]$RootPid) {
    $processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
    $ids = [System.Collections.Generic.HashSet[int]]::new()
    [void]$ids.Add($RootPid)
    do {
        $added = $false
        foreach ($candidate in $processes) {
            if ($ids.Contains([int]$candidate.ParentProcessId) -and $ids.Add([int]$candidate.ProcessId)) {
                $added = $true
            }
        }
    } while ($added)
    return @($ids)
}

function Assert-DebugPortOwnedByProcess([int]$Port, [int]$RootPid) {
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
        $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalAddress -eq '127.0.0.1' } |
            Select-Object -First 1
        if ($listener) {
            $tree = @(Get-ProcessTreeIds $RootPid)
            if ($tree -notcontains [int]$listener.OwningProcess) {
                throw "Debug port $Port is owned by untrusted PID $($listener.OwningProcess)"
            }
            return $tree
        }
        Start-Sleep -Milliseconds 200
    }
    throw "Debug port $Port did not become ready for PID $RootPid"
}

function Get-TestOwnedProcessIds([int[]]$KnownProcessIds, [string]$UserDataPath) {
    $ids = [System.Collections.Generic.HashSet[int]]::new()
    foreach ($id in @($KnownProcessIds)) { if ($id -gt 0) { [void]$ids.Add([int]$id) } }
    foreach ($candidate in @(Get-CimInstance Win32_Process | Select-Object ProcessId, CommandLine)) {
        if ($candidate.CommandLine -and $candidate.CommandLine.IndexOf($UserDataPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            [void]$ids.Add([int]$candidate.ProcessId)
        }
    }
    return @($ids)
}

function Stop-TestProcessTree($Process, [int[]]$KnownProcessIds, [string]$UserDataPath) {
    $ownedIds = @(Get-TestOwnedProcessIds -KnownProcessIds $KnownProcessIds -UserDataPath $UserDataPath)
    if ($Process -and -not $Process.HasExited) { $ownedIds += [int]$Process.Id }
    foreach ($id in @($ownedIds | Select-Object -Unique)) {
        if ($id -eq $PID -or -not (Get-Process -Id $id -ErrorAction SilentlyContinue)) { continue }
        & taskkill.exe /PID $id /T /F 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0 -and (Get-Process -Id $id -ErrorAction SilentlyContinue)) {
            throw "Failed to terminate test-owned process tree rooted at PID $id"
        }
    }
    Start-Sleep -Milliseconds 300
    $remaining = @(Get-TestOwnedProcessIds -KnownProcessIds $ownedIds -UserDataPath $UserDataPath |
        Where-Object { $_ -ne $PID -and (Get-Process -Id $_ -ErrorAction SilentlyContinue) })
    if ($remaining.Count -gt 0) {
        throw "Test-owned process cleanup incomplete: $($remaining -join ',')"
    }
}

function Assert-RequiredMarkers([object[]]$Output, [string[]]$Markers, [string]$Stage) {
    $text = $Output -join "`n"
    foreach ($marker in $Markers) {
        if ($text -notmatch [regex]::Escape($marker)) {
            throw "$Stage missing required marker: $marker"
        }
    }
}

function Write-SanitizedHost($lines) {
    if ($null -eq $lines) { return }
    $repoStr = "$repoRoot"
    $profStr = "$($env:USERPROFILE)"
    $forwardRepo = $repoStr.Replace('\', '/')
    $forwardProfile = $profStr.Replace('\', '/')
    foreach ($line in @($lines)) {
        $clean = [string]$line
        $clean = $clean -replace [regex]::Escape($repoStr), '<REPO>'
        $clean = $clean -replace [regex]::Escape($forwardRepo), '<REPO>'
        $clean = $clean -replace [regex]::Escape($profStr), '<USERPROFILE>'
        $clean = $clean -replace [regex]::Escape($forwardProfile), '<USERPROFILE>'
        Write-Host $clean
    }
}

Write-Host "================================================================="
Write-Host "Windows Desktop Lite Product Completeness & UI Automation"
Write-Host "================================================================="

# Determine mode before any optional packaging work.
$selectedModes = @(
    if ($ContractOnly) { 'ContractOnly' }
    if ($LiveLocalLlm) { 'LiveLocalLlm' }
    if ($CoreProduct) { 'CoreProduct' }
    if ($Resilience) { 'Resilience' }
    if ($AuthContracts) { 'AuthContracts' }
    if ($NativeVoice) { 'NativeVoice' }
)
if ($selectedModes.Count -gt 1) {
    throw "Multiple verification modes were selected; choose exactly one mode switch or none for All"
}
$mode = "All"
if ($ContractOnly) { $mode = "ContractOnly" }
elseif ($LiveLocalLlm) { $mode = "LiveLocalLlm" }
elseif ($CoreProduct) { $mode = "CoreProduct" }
elseif ($Resilience) { $mode = "Resilience" }
elseif ($AuthContracts) { $mode = "AuthContracts" }
elseif ($NativeVoice) { $mode = "NativeVoice" }

Write-Host "==> Verification Mode: $mode"

$actualCodeSha = (& git rev-parse HEAD 2>$null).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $actualCodeSha -notmatch '^[0-9a-f]{40}$') {
    throw "Unable to resolve the checked-out Git HEAD"
}
$expectedSha = $ExpectedCodeSha.Trim().ToLowerInvariant()
if ($expectedSha -notmatch '^[0-9a-f]{40}$') { throw "ExpectedCodeSha must be a full 40-character Git SHA" }
if ($actualCodeSha -ne $expectedSha) {
    throw "Checked-out HEAD $actualCodeSha does not match ExpectedCodeSha $expectedSha"
}
$dirtyEntries = @(& git status --porcelain --untracked-files=all)
if ($LASTEXITCODE -ne 0) { throw "Unable to inspect Git worktree status" }
if ($dirtyEntries.Count -gt 0) { throw "Verification worktree must be clean before packaging" }
Write-Host "CODE_TESTED_SHA=$actualCodeSha"

$nodeExe = (Get-Command node -ErrorAction Stop).Source
$requiresFreshPackage = @('All', 'NativeVoice') -contains $mode
if ($requiresFreshPackage -and -not [string]::IsNullOrWhiteSpace($ExecutablePath)) {
    throw "$mode mode requires a fresh package from the checked-out source; do not pass -ExecutablePath"
}

# 1. Locate Packaged Executable
$appExe = $ExecutablePath
if ([string]::IsNullOrWhiteSpace($appExe)) {
    $unpackedPath = Join-Path $repoRoot "dist\win-unpacked\Voice Practice.exe"
    if ($requiresFreshPackage) {
        $distPath = Join-Path $repoRoot "dist"
        if (Test-Path -LiteralPath $distPath) {
            Write-Host "Removing existing dist to prevent stale-binary evidence..."
            Remove-Item -LiteralPath $distPath -Recurse -Force
        }
        Write-Host "Building a fresh Windows package from the checked-out source..."
        $buildStartedAtUtc = [DateTime]::UtcNow.ToString("o")
        $packRaw = & cmd.exe /c "npm run pack:win 2>&1"
        if ($LASTEXITCODE -ne 0) { throw "npm run pack:win failed" }
        Write-SanitizedHost $packRaw
        & $nodeExe (Join-Path $repoRoot "scripts\write-checksums.mjs") "dist"
        if ($LASTEXITCODE -ne 0) { throw "write-checksums.mjs failed" }
        $pkgRaw = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot "scripts\verify-windows-package.ps1") -ExpectedCodeSha $actualCodeSha -BuildStartedAtUtc $buildStartedAtUtc 2>&1
        if ($LASTEXITCODE -ne 0) { throw "Windows package lifecycle verification failed" }
        Write-SanitizedHost $pkgRaw
    }
    elseif (-not (Test-Path $unpackedPath)) {
        throw "Packaged executable not found for partial mode; run npm run pack:win first or pass -ExecutablePath"
    }
    $appExe = $unpackedPath
}

if (-not (Test-Path $appExe)) {
    throw "Executable not found at: $appExe"
}

$exeItem = Get-Item $appExe
$exeHash = (Get-FileHash -Path $appExe -Algorithm SHA256).Hash.ToLower()
Write-Host "==> Target Executable: packaged win-unpacked application (absolute path suppressed)"
Write-Host "    Size: $([math]::Round($exeItem.Length / 1MB, 2)) MB"
Write-Host "    SHA-256: $exeHash"

# 2. Setup Temp UserData & Ephemeral Port
$tempUserData = Join-Path ([System.IO.Path]::GetTempPath()) ("voice-practice-e2e-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempUserData | Out-Null
$artifactDir = Join-Path $tempUserData "e2e-artifacts"
New-Item -ItemType Directory -Path $artifactDir | Out-Null
Write-Host "==> Created isolated TEMP userData (absolute path suppressed)"

$port = Get-FreeTcpPort
Write-Host "==> Using ephemeral debugging port: $port"

$proc = $null
$proc2 = $null
$procTree = @()
$proc2Tree = @()

try {
    # 4. Launch Packaged Electron App
    Write-Host "==> Launching packaged application..."
    $proc = Start-Process -FilePath $appExe -ArgumentList @("--user-data-dir=`"$tempUserData`"", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=$port") -PassThru
    Write-Host "    Spawned PID: $($proc.Id)"
    $procTree = @(Assert-DebugPortOwnedByProcess -Port $port -RootPid $proc.Id)

    # 5. Run Node CDP Driver
    $driverScript = Join-Path $repoRoot "scripts\windows-product-e2e.cjs"
    Write-Host "==> Running packaged UI driver"
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $driverOutput = & $nodeExe $driverScript "--port=$port" "--mode=$mode" "--artifact-dir=$artifactDir" 2>&1
    $driverExitCode = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    Write-SanitizedHost $driverOutput

    if ($driverExitCode -ne 0) {
        throw "UI Driver exited with error code: $driverExitCode"
    }
    $driverMarkers = @('DRIVER_CONNECT_OK', 'PACKAGED_APP_TITLE_OK', 'APP_SHELL_DOM_OK')
    if ($mode -eq 'LiveLocalLlm' -or $mode -eq 'All') {
        $driverMarkers += @('LLAMACPP_UI_MODELS_OK:ornith-9b', 'LLAMACPP_UI_CHAT_1_OK', 'LLAMACPP_UI_CHAT_2_OK', 'RENDERER_DIRECT_FETCHES=0')
    }
    if ($mode -eq 'CoreProduct' -or $mode -eq 'All') {
        $driverMarkers += @('LESSON_IMPORT_EXPORT_ROUNDTRIP_OK', 'SHADOWING_FIXTURE_SCORE_OK', 'CORE_PRODUCT_FLOWS_OK')
    }
    if ($mode -eq 'Resilience' -or $mode -eq 'All') {
        $driverMarkers += @('OFFLINE_BUNDLED_UI_OK', 'ERROR_RECOVERY_CHAT_OK', 'RESILIENCE_FLOWS_OK')
    }
    if ($mode -eq 'NativeVoice') {
        $driverMarkers += @('NATIVE_VOICE_HEALTH_OK', 'NATIVE_VOICE_SYNTH_OK', 'NATIVE_VOICE_UI_STATUS_OK', 'NATIVE_VOICE_ALL_OK')
    }
    Assert-RequiredMarkers -Output $driverOutput -Markers $driverMarkers -Stage 'UI driver'

    # 6. If Resilience or All: Verify Second Instance Focus while primary instance is running
    if ($Resilience -or $mode -eq "All") {
        Write-Host "`n==> Testing Second Instance Enforcement & Focus..."
        $secondProc = Start-Process -FilePath $appExe -ArgumentList @("--user-data-dir=`"$tempUserData`"") -Wait -PassThru
        if ($secondProc.ExitCode -ne 0) {
            throw "Second instance did not exit with code 0 (exit code: $($secondProc.ExitCode))"
        }
        Write-Host "    [OK] Second instance cleanly exited (single-instance enforced)"
        Write-Host "SECOND_INSTANCE_EXIT_OK"
    }

    # 7. Close primary instance cleanly to flush LevelDB before restart
    Write-Host "`n==> Closing primary instance cleanly..."
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & $nodeExe $driverScript "--port=$port" "--mode=CleanClose" 2>&1 | Out-Null
    $closeExit = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    if ($closeExit -ne 0) { throw "CleanClose driver failed" }
    $proc.WaitForExit(5000)
    if (-not $proc.HasExited) {
        Stop-TestProcessTree -Process $proc -KnownProcessIds $procTree -UserDataPath $tempUserData
    }
    Start-Sleep -Seconds 1

    # 8. If LiveLocalLlm or All: Verify Restart Persistence
    if ($LiveLocalLlm -or $CoreProduct -or $mode -eq "All") {
        Write-Host "`n==> Testing App Restart Persistence with preserved userData..."
        $port2 = Get-FreeTcpPort
        Write-Host "    Restarting app on port $port2 with preserved isolated userData (absolute path suppressed)"
        $proc2 = Start-Process -FilePath $appExe -ArgumentList @("--user-data-dir=`"$tempUserData`"", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=$port2") -PassThru
        Write-Host "    Restarted PID: $($proc2.Id)"
        $proc2Tree = @(Assert-DebugPortOwnedByProcess -Port $port2 -RootPid $proc2.Id)

        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        $restartOutput = & $nodeExe $driverScript "--port=$port2" "--mode=RestartCheck" 2>&1
        $restartExit = $LASTEXITCODE
        $ErrorActionPreference = $prevEap
        Write-SanitizedHost $restartOutput
        if ($restartExit -ne 0) {
            throw "Restart persistence check failed"
        }
        $restartMarkers = @('DRIVER_CONNECT_OK', 'PACKAGED_APP_TITLE_OK', 'APP_SHELL_DOM_OK')
        if ($CoreProduct -or $mode -eq 'All') {
            $restartMarkers += @('LESSON_PROGRESS_RESTART_OK', 'LESSON_LIBRARY_RESTART_OK')
        }
        if ($LiveLocalLlm -or $mode -eq 'All') {
            $restartMarkers += 'LLAMACPP_UI_RESTART_OK'
        }
        Assert-RequiredMarkers -Output $restartOutput -Markers $restartMarkers -Stage 'Restart driver'
        $proc2.WaitForExit(5000)
        if (-not $proc2.HasExited) {
            Stop-TestProcessTree -Process $proc2 -KnownProcessIds $proc2Tree -UserDataPath $tempUserData
        }
    }

    # 8. If AuthContracts or All: Run credential contract
    if ($AuthContracts -or $mode -eq "All") {
        Write-Host "`n==> Running Auth and DPAPI Contracts..."
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        $authOutput = & $nodeExe --test tests/windows-credential-contract.test.cjs tests/windows-provider-routing.test.cjs 2>&1
        $authExit = $LASTEXITCODE
        $ErrorActionPreference = $prevEap
        Write-SanitizedHost $authOutput
        if ($authExit -ne 0) {
            throw "Auth credential contract failed"
        }
        Write-Host "AUTH_CONTRACTS_OK"
        Write-Host "LOCAL_PROVIDER_NO_SECRET_CONTRACT_OK"
    }

    Write-Host "`n================================================================="
    if ($mode -eq "All") {
        Write-Host "AUTOMATED SELECTED GATES: PASSED"
        Write-Host "Acceptance: PENDING PLANNER REVIEW AND MANUAL/NATIVE BOUNDARIES"
        Write-Host "NOT_RUN: F-03,F-05,F-09,F-15,F-17,F-21,F-22"
        Write-Host "NATIVE_VOICE_UNAVAILABLE: F-22b"
        Write-Host "Overall Lane Status: AUTOMATED_SELECTED_GATES_PASS"
    }
    else {
        Write-Host "MODE VERIFICATION PASSED: $mode"
        Write-Host "Overall Lane Status: NOT_EVALUATED_BY_PARTIAL_MODE"
    }
    Write-Host "================================================================="
}
finally {
    Write-Host "`n==> Cleaning up test processes and temporary files..."
    Stop-TestProcessTree -Process $proc -KnownProcessIds $procTree -UserDataPath $tempUserData
    Stop-TestProcessTree -Process $proc2 -KnownProcessIds $proc2Tree -UserDataPath $tempUserData
    if (Test-Path $tempUserData) {
        for ($i = 0; $i -lt 15; $i++) {
            Remove-Item -Path $tempUserData -Recurse -Force -ErrorAction SilentlyContinue
            if (-not (Test-Path $tempUserData)) { break }
            Start-Sleep -Milliseconds 200
        }
    }
    if (Test-Path $tempUserData) { throw "Temporary userData cleanup failed" }
    Write-Host "    [OK] Cleanup completed."
}
