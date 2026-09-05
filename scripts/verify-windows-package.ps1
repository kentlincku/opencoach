# Verify Windows Desktop Lite packaged application lifecycle and artifacts.
param(
    [Parameter(Mandatory = $true)][string]$ExpectedCodeSha,
    [Parameter(Mandatory = $true)][DateTime]$BuildStartedAtUtc,
    [string]$DistDir = "dist",
    [string]$LifecycleRoot = "",
    [switch]$SkipSmokeTest,
    [switch]$SkipLifecycle
)

$ErrorActionPreference = "Stop"

if ($ExpectedCodeSha -notmatch '^[0-9a-fA-F]{40}$') { throw "ExpectedCodeSha must be a full 40-character commit SHA" }
$actualCodeSha = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $actualCodeSha -ne $ExpectedCodeSha.ToLowerInvariant()) {
    throw "Source SHA mismatch: expected=$ExpectedCodeSha actual=$actualCodeSha"
}
$dirty = @(git status --porcelain)
if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) { throw "Worktree must be clean for fixed-SHA package verification" }

function Wait-PathState {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][bool]$ShouldExist,
        [int]$TimeoutSeconds = 20
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if ((Test-Path -LiteralPath $Path) -eq $ShouldExist) { return }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timed out waiting for path state: path=$Path shouldExist=$ShouldExist"
}

function Get-RelativePathCompat {
    param(
        [Parameter(Mandatory = $true)][string]$From,
        [Parameter(Mandatory = $true)][string]$To
    )
    $method = ([System.IO.Path]).GetMethod('GetRelativePath', [type[]]@([string], [string]))
    if ($method) {
        return [System.IO.Path]::GetRelativePath($From, $To)
    }
    $fromPath = [System.IO.Path]::GetFullPath($From).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    $toPath = [System.IO.Path]::GetFullPath($To)
    $fromUri = [System.Uri]::new($fromPath)
    $toUri = [System.Uri]::new($toPath)
    if ($fromUri.Scheme -ne $toUri.Scheme -or $fromUri.Host -ne $toUri.Host) {
        return $toPath
    }
    $relativeUri = $fromUri.MakeRelativeUri($toUri)
    return [System.Uri]::UnescapeDataString($relativeUri.ToString()).Replace('/', [System.IO.Path]::DirectorySeparatorChar)
}

Write-Host "==> Step 1: Checking distribution directory: $DistDir"
if (-not (Test-Path -LiteralPath $DistDir -PathType Container)) {
    throw "Distribution directory not found: $DistDir. Run the fresh package driver first."
}
$distPath = (Resolve-Path -LiteralPath $DistDir).Path
$packageVersion = (Get-Content -LiteralPath "package.json" -Raw | ConvertFrom-Json).version
$setupCandidates = @(Get-ChildItem -LiteralPath $distPath -Filter "Voice-Practice-Setup-$packageVersion-x64.exe" -File)
$portableCandidates = @(Get-ChildItem -LiteralPath $distPath -Filter "Voice-Practice-Portable-$packageVersion-x64.exe" -File)
if ($setupCandidates.Count -ne 1) { throw "Expected exactly one deterministic NSIS artifact; found $($setupCandidates.Count)" }
if ($portableCandidates.Count -ne 1) { throw "Expected exactly one deterministic Portable artifact; found $($portableCandidates.Count)" }
$setupExe = $setupCandidates[0]
$portableExe = $portableCandidates[0]
$sourceShaFile = Join-Path $distPath "SOURCE_SHA.txt"
if (-not (Test-Path -LiteralPath $sourceShaFile -PathType Leaf)) { throw "SOURCE_SHA.txt missing from fresh output" }
if ((Get-Content -LiteralPath $sourceShaFile -Raw).Trim() -ne $actualCodeSha) { throw "SOURCE_SHA.txt does not bind output to current HEAD" }
$checksumFile = Join-Path $distPath "SHA256SUMS.txt"
if (-not (Test-Path -LiteralPath $checksumFile -PathType Leaf)) { throw "SHA256SUMS.txt not found in fresh output" }
foreach ($artifact in @($setupExe, $portableExe, (Get-Item -LiteralPath $sourceShaFile), (Get-Item -LiteralPath $checksumFile))) {
    if ($artifact.LastWriteTimeUtc -lt $BuildStartedAtUtc.ToUniversalTime()) {
        throw "Stale output predates BuildStartedAtUtc: $($artifact.Name)"
    }
}

Write-Host "`n==> Step 2: Checking executable artifacts and hashes"
$setupHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $setupExe.FullName).Hash.ToLowerInvariant()
$portableHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $portableExe.FullName).Hash.ToLowerInvariant()
Write-Host "  NSIS Setup: $($setupExe.Name) ($([math]::Round($setupExe.Length / 1MB, 2)) MB, SHA-256: $setupHash)"
Write-Host "  Portable:   $($portableExe.Name) ($([math]::Round($portableExe.Length / 1MB, 2)) MB, SHA-256: $portableHash)"

Write-Host "`n==> Step 3: Verifying checksums manifest contents"
$checksumContent = @(Get-Content -LiteralPath $checksumFile)
foreach ($entry in @(
    "$setupHash  $($setupExe.Name)",
    "$portableHash  $($portableExe.Name)"
)) {
    if ($checksumContent -notcontains $entry) {
        throw "Checksum mismatch or missing entry: $entry"
    }
}
Write-Host "  [OK] SHA256SUMS.txt contains matching setup and portable entries"

if (-not $SkipSmokeTest) {
    Write-Host "`n==> Step 4: Unpacked app smoke test"
    $unpackedExe = Join-Path $distPath "win-unpacked\Voice Practice.exe"
    if (-not (Test-Path -LiteralPath $unpackedExe -PathType Leaf)) {
        throw "win-unpacked executable not found: $unpackedExe"
    }
    $smokeOutput = cmd.exe /d /s /c "`"$unpackedExe`" --smoke-test 2>&1"
    $smokeExitCode = $LASTEXITCODE
    $smokeOutput | Write-Host
    if ($smokeExitCode -ne 0) { throw "Unpacked smoke test failed with exit code: $smokeExitCode" }
    if (($smokeOutput -join "`n") -notmatch [regex]::Escape('PACKAGED_APP_SMOKE_OK:')) {
        throw "Unpacked smoke test missing PACKAGED_APP_SMOKE_OK: marker"
    }
    Write-Host "  [OK] Unpacked app smoke test passed"

    Write-Host "`n==> Step 5: Portable executable smoke test"
    $portableResultFile = Join-Path ([System.IO.Path]::GetTempPath()) ("voice-practice-portable-smoke-" + [Guid]::NewGuid().ToString("N") + ".txt")
    $hadPreviousSmokeResult = Test-Path Env:VOICE_PRACTICE_SMOKE_RESULT_FILE
    $previousSmokeResult = $env:VOICE_PRACTICE_SMOKE_RESULT_FILE
    try {
        $env:VOICE_PRACTICE_SMOKE_RESULT_FILE = $portableResultFile
        $portableProc = Start-Process -FilePath $portableExe.FullName -ArgumentList "--smoke-test" -Wait -PassThru
        $portableExitCode = $portableProc.ExitCode
        if ($portableExitCode -ne 0) { throw "Portable smoke test failed with exit code: $portableExitCode" }
        Wait-PathState -Path $portableResultFile -ShouldExist $true
        $portableOutput = Get-Content -LiteralPath $portableResultFile -Raw -Encoding UTF8
        $portableOutput | Write-Host
        $expectedPortableMarker = 'PACKAGED_APP_SMOKE_OK:Voice Practice · 可愛虛擬英語教練 (Local-first)'
        if ($portableOutput.Trim() -ne $expectedPortableMarker) {
            throw "Portable smoke test marker/title did not match the expected UTF-8 product title"
        }
        Write-Host "  [OK] PORTABLE_SMOKE_OK (verified application-owned sentinel)"
    }
    finally {
        if ($hadPreviousSmokeResult) {
            $env:VOICE_PRACTICE_SMOKE_RESULT_FILE = $previousSmokeResult
        } else {
            Remove-Item Env:VOICE_PRACTICE_SMOKE_RESULT_FILE -ErrorAction SilentlyContinue
        }
        Remove-Item -LiteralPath $portableResultFile -Force -ErrorAction SilentlyContinue
    }
}

if (-not $SkipLifecycle) {
    Write-Host "`n==> Step 6: Isolated NSIS install, smoke, and uninstall lifecycle"
    $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    if (-not $LifecycleRoot) {
        $LifecycleRoot = Join-Path $tempRoot ("voice-practice-lifecycle-" + [Guid]::NewGuid().ToString("N"))
    }
    $lifecyclePath = [System.IO.Path]::GetFullPath($LifecycleRoot)
    $relativeLifecycle = Get-RelativePathCompat -From $tempRoot -To $lifecyclePath
    if ([System.IO.Path]::IsPathRooted($relativeLifecycle) -or $relativeLifecycle -eq '.' -or $relativeLifecycle.StartsWith('..')) {
        throw "LifecycleRoot must be contained by the system temporary directory: $tempRoot"
    }
    if (Test-Path -LiteralPath $lifecyclePath) {
        throw "Test lifecycle directory already exists; refusing to remove or reuse it: $lifecyclePath"
    }

    $installDir = Join-Path $lifecyclePath "Voice Practice"
    $installedApp = Join-Path $installDir "Voice Practice.exe"
    $uninstaller = Join-Path $installDir "Uninstall Voice Practice.exe"
    New-Item -ItemType Directory -Path $lifecyclePath | Out-Null

    try {
        Write-Host "  Installing silently into isolated test directory"
        $setupProc = Start-Process -FilePath $setupExe.FullName -ArgumentList @("/S", "/D=$installDir") -Wait -PassThru
        if ($setupProc.ExitCode -ne 0) { throw "NSIS silent installation failed with exit code: $($setupProc.ExitCode)" }
        Wait-PathState -Path $installedApp -ShouldExist $true
        Wait-PathState -Path $uninstaller -ShouldExist $true
        Write-Host "  [OK] NSIS_INSTALL_OK (isolated per-user test path; no elevation requested by this script)"

        $installedOutput = cmd.exe /d /s /c "`"$installedApp`" --smoke-test 2>&1"
        $installedExitCode = $LASTEXITCODE
        $installedOutput | Write-Host
        if ($installedExitCode -ne 0) { throw "Installed app smoke test failed with exit code: $installedExitCode" }
        if (($installedOutput -join "`n") -notmatch [regex]::Escape('PACKAGED_APP_SMOKE_OK:')) {
            throw "Installed app smoke test missing PACKAGED_APP_SMOKE_OK: marker"
        }
        Write-Host "  [OK] Installed app smoke test passed"

        Write-Host "  UPGRADE: NOT_RUN - no previous signed/engineering version artifact was supplied"

        $uninstallProc = Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait -PassThru
        if ($uninstallProc.ExitCode -ne 0) { throw "Uninstaller failed with exit code: $($uninstallProc.ExitCode)" }
        Wait-PathState -Path $installedApp -ShouldExist $false
        Write-Host "  [OK] NSIS_UNINSTALL_OK"
    }
    finally {
        if (Test-Path -LiteralPath $uninstaller) {
            $cleanupProc = Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait -PassThru
            if ($cleanupProc.ExitCode -ne 0) {
                Write-Warning "Isolated test uninstaller cleanup exited $($cleanupProc.ExitCode): $uninstaller"
            }
        }
        if (Test-Path -LiteralPath $lifecyclePath) {
            Remove-Item -LiteralPath $lifecyclePath -Recurse -Force
        }
    }
}

Write-Host "`n==> Windows Packaging Lifecycle Verification: PASSED"
