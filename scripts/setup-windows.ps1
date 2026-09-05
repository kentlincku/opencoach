param(
    [switch]$VerifyAssetsOnly
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

Require-Command "uv" "Install it from https://docs.astral.sh/uv/."
Require-Command "npm" "Install Node.js from https://nodejs.org/."

if (-not (Test-Path ".venv\Scripts\python.exe")) {
    Invoke-Checked { uv venv --python 3.11 .venv } "Python environment creation"
}
Invoke-Checked { uv pip install --python ".venv\Scripts\python.exe" -r "native\python\requirements-windows.txt" } "Python dependency installation"

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
