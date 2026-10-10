param(
    [switch]$VerifyAssetsOnly,
    [string]$Bundle,
    [string]$BundleSha256,
    [string]$Wheelhouse,
    [string]$Prepared
)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

function Require-Command([string]$Name, [string]$Help) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name is required. $Help"
    }
}

function Invoke-Checked([scriptblock]$Command, [string]$Label) {
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE" }
}

function Assert-VerifiedAsset(
    [string]$Path,
    [string]$Sha256
) {
    if (-not (Test-Path $Path)) { throw "Missing asset: $(Split-Path -Leaf $Path)" }
    $actual = (Get-FileHash -Algorithm SHA256 $Path).Hash.ToLowerInvariant()
    if ($actual -ne $Sha256) { throw "Checksum mismatch for $(Split-Path -Leaf $Path)" }
}

function Install-VerifiedAsset(
    [string]$Url,
    [string]$Destination,
    [string]$Sha256
) {
    if (Test-Path $Destination) {
        $current = (Get-FileHash -Algorithm SHA256 $Destination).Hash.ToLowerInvariant()
        if ($current -eq $Sha256) { return }
        Remove-Item -Force $Destination
    }

    $partial = "$Destination.partial"
    Remove-Item -Force -ErrorAction SilentlyContinue $partial
    Write-Host "Downloading $(Split-Path -Leaf $Destination)..."
    Invoke-WebRequest -Uri $Url -OutFile $partial -UseBasicParsing
    $actual = (Get-FileHash -Algorithm SHA256 $partial).Hash.ToLowerInvariant()
    if ($actual -ne $Sha256) {
        Remove-Item -Force -ErrorAction SilentlyContinue $partial
        throw "Checksum mismatch for $(Split-Path -Leaf $Destination)"
    }
    Move-Item -Force $partial $Destination
}

$assetDir = Join-Path (Get-Location) ".runtime\kokoro-onnx"
$modelPath = Join-Path $assetDir "kokoro-v1.0.int8.onnx"
$voicesPath = Join-Path $assetDir "voices-v1.0.bin"
$modelSha256 = "ae315a79b623f244700e4afb9246c46a26066782e049ba174bf3ba433970ee9c"
$voicesSha256 = "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d"

if ($VerifyAssetsOnly) {
    Assert-VerifiedAsset $modelPath $modelSha256
    Assert-VerifiedAsset $voicesPath $voicesSha256
    Write-Host "Kokoro assets verified."
    exit 0
}

if (-not $Bundle -or $BundleSha256 -notmatch '^[a-f0-9]{64}$' -or -not $Wheelhouse -or -not $Prepared) {
    throw "Approved bundle input required: rerun setup-windows.ps1 -Bundle <bundle.json> -BundleSha256 <sha256> -Wheelhouse <offline-wheels> -Prepared <new-owned-directory>. Public requirements-windows.txt alone is not a runtime."
}
if (-not (Test-Path -LiteralPath $Bundle -PathType Leaf) -or -not (Test-Path -LiteralPath $Wheelhouse -PathType Container)) {
    throw "Approved bundle or wheelhouse is missing; no downloads started."
}
Assert-VerifiedAsset $Bundle $BundleSha256
if (Test-Path -LiteralPath $Prepared) { throw "Prepared output already exists; choose a new owned directory." }
Require-Command "uv" "Install it from https://docs.astral.sh/uv/."
Require-Command "npm" "Install Node.js from https://nodejs.org/."

if (-not (Test-Path ".venv\Scripts\python.exe")) {
    # stdlib venv avoids untracked _virtualenv.py/.pth bootstrap code. No Python download.
    $bootstrapPython = & uv python find --offline 3.11
    if ($LASTEXITCODE -ne 0) { throw "An installed Windows x64 CPython 3.11 is required." }
    Invoke-Checked { & $bootstrapPython -I -B -m venv --without-pip .venv } "Python environment creation"
}
$python = ".venv\Scripts\python.exe"
$driver = "spikes\packaged-runtime\build-runtime.py"
Invoke-Checked { & $python -I -B $driver --prepare-only --bundle $Bundle --bundle-sha256 $BundleSha256 --wheelhouse $Wheelhouse --output $Prepared } "Full code/resource/wheelhouse admission"
$installLock = Join-Path $Prepared "install.lock.txt"
Invoke-Checked { uv --no-config pip install --offline --python $python --no-index --no-deps --require-hashes --only-binary :all: --find-links $Wheelhouse -r $installLock } "Hash-locked full vendor dependency installation"
Invoke-Checked { & $python -I -B $driver --verify-only --bundle $Bundle --bundle-sha256 $BundleSha256 --wheelhouse $Wheelhouse --prepared $Prepared } "Installed full runtime input verification"

# Keep Electron and all dev dependencies reproducible from package-lock.json.
npm ci --include=dev
if ($LASTEXITCODE -ne 0) { throw "Node dependency installation failed with exit code $LASTEXITCODE" }

New-Item -ItemType Directory -Force -Path $assetDir | Out-Null
Install-VerifiedAsset `
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.int8.onnx" `
    $modelPath `
    $modelSha256
Install-VerifiedAsset `
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.0.bin" `
    $voicesPath `
    $voicesSha256

Write-Host "Windows development runtime is ready."
