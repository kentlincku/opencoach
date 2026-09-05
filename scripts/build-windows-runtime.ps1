[CmdletBinding()]
param(
    [switch]$Clean,
    [switch]$DryRun,
    [string]$OutputDir = "dist/voice-runtime"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Get-Item $PSScriptRoot).Parent.FullName

Write-Host "=== Building Windows Native Voice Runtime (x64 CPU) ==="

$inPath = Join-Path $repoRoot "spikes/packaged-runtime/requirements-windows-x64.in"
$lockPath = Join-Path $repoRoot "spikes/packaged-runtime/requirements-windows-x64.lock.txt"
$specPath = Join-Path $repoRoot "spikes/packaged-runtime/voice-runtime.spec"

if (-not (Test-Path $lockPath)) {
    throw "Locked requirements file not found: $lockPath"
}

if ($DryRun) {
    Write-Host "[DRY RUN] Would install lock file and run PyInstaller on $specPath"
    exit 0
}

# Ensure isolated build venv
$buildVenv = Join-Path $repoRoot ".venv-runtime-build"
if ($Clean -and (Test-Path $buildVenv)) {
    Write-Host "Cleaning build venv: $buildVenv"
    Remove-Item -LiteralPath $buildVenv -Recurse -Force
}

if (-not (Test-Path $buildVenv)) {
    Write-Host "Creating build venv with Python 3.11..."
    uv venv $buildVenv --python 3.11
}

$venvPython = Join-Path $buildVenv "Scripts/python.exe"

Write-Host "Synchronizing build dependencies from locked hashes..."
uv pip sync --require-hashes $lockPath --python $venvPython

# Replace the official faster-whisper package code with the reviewed WAV-only
# source prepared from the exact upstream Git SHA plus the committed patch.
# The public repository intentionally does not carry a generated wheel.
$sitePackages = (& $venvPython -c "import site; print(site.getsitepackages()[0])").Trim()
$patchedPackage = Join-Path $sitePackages "faster_whisper"
Write-Host "Preparing pinned faster-whisper WAV-only source tree..."
& $venvPython "$repoRoot/scripts/build-faster-whisper-wavonly.py" --install-into $patchedPackage
if ($LASTEXITCODE -ne 0) {
    throw "Pinned faster-whisper source preparation failed with exit code $LASTEXITCODE"
}

# Run PyInstaller
Write-Host "Executing PyInstaller build..."
$distDir = Join-Path $repoRoot "dist"
$buildDir = Join-Path $repoRoot "build/runtime"

if ($Clean) {
    if (Test-Path (Join-Path $distDir "voice-runtime")) {
        Remove-Item -LiteralPath (Join-Path $distDir "voice-runtime") -Recurse -Force
    }
    if (Test-Path $buildDir) {
        Remove-Item -LiteralPath $buildDir -Recurse -Force
    }
}

& $venvPython -m PyInstaller --clean --noconfirm --distpath $distDir --workpath $buildDir $specPath
if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller build failed with exit code $LASTEXITCODE"
}

$runtimeDist = Join-Path $distDir "voice-runtime"
if (-not (Test-Path (Join-Path $runtimeDist "voice-runtime.exe"))) {
    throw "Build artifact voice-runtime.exe missing in $runtimeDist"
}

# Copy legal notice and license files into runtime payload
$legalDir = Join-Path $repoRoot "legal"
if (Test-Path $legalDir) {
    Write-Host "Copying legal notice and third-party license files to $runtimeDist..."
    Copy-Item (Join-Path $legalDir "*") -Destination $runtimeDist -Force
}

# Generate and verify runtime-manifest.json using check-windows-runtime.mjs
Write-Host "Generating and verifying runtime tree manifest with check-windows-runtime.mjs..."
node "$repoRoot/scripts/check-windows-runtime.mjs" --generate --runtime-dir $runtimeDist
if ($LASTEXITCODE -ne 0) {
    throw "Runtime check verification failed!"
}

Write-Host "=== Windows Native Voice Runtime build SUCCESS ==="
Write-Host "Artifacts location: $runtimeDist"
