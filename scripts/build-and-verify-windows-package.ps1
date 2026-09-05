[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ExpectedCodeSha,
    [string]$DistDir = "dist",
    [switch]$SkipSmokeTest,
    [switch]$SkipLifecycle
)
$ErrorActionPreference = "Stop"
if ($ExpectedCodeSha -notmatch '^[0-9a-fA-F]{40}$') { throw "ExpectedCodeSha must be a full 40-character commit SHA" }
$repoRootText = (git rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0 -or -not $repoRootText) { throw "Unable to resolve repository root" }
$repoRoot = [System.IO.Path]::GetFullPath($repoRootText)
$currentDirectory = [System.IO.Path]::GetFullPath((Get-Location).Path)
if (-not [System.StringComparer]::OrdinalIgnoreCase.Equals($currentDirectory, $repoRoot)) {
    throw "Fresh package driver must run from the repository root"
}
$canonicalDistPath = [System.IO.Path]::GetFullPath((Join-Path $repoRoot "dist"))
$requestedDistPath = if ([System.IO.Path]::IsPathRooted($DistDir)) {
    [System.IO.Path]::GetFullPath($DistDir)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $repoRoot $DistDir))
}
if (-not [System.StringComparer]::OrdinalIgnoreCase.Equals($requestedDistPath, $canonicalDistPath)) {
    throw "DistDir must be the canonical repository dist directory: $canonicalDistPath"
}
$distPath = $canonicalDistPath
$actual = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $actual -ne $ExpectedCodeSha.ToLowerInvariant()) { throw "Source SHA mismatch before build" }
$dirty = @(git status --porcelain)
if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) { throw "Worktree must be clean before build" }
if (Test-Path -LiteralPath $distPath) {
    $distItem = Get-Item -LiteralPath $distPath -Force
    if (-not $distItem.PSIsContainer) { throw "Canonical dist path exists but is not a directory" }
    if (($distItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Canonical dist directory must not be a ReparsePoint"
    }
    Remove-Item -LiteralPath $distPath -Recurse -Force
}
$buildStarted = [DateTime]::UtcNow
npm run pack:win
if ($LASTEXITCODE -ne 0) { throw "npm run pack:win failed: $LASTEXITCODE" }
Set-Content -LiteralPath (Join-Path $distPath "SOURCE_SHA.txt") -Value $actual -Encoding ascii -NoNewline
node scripts/write-checksums.mjs $distPath
if ($LASTEXITCODE -ne 0) { throw "checksum generation failed: $LASTEXITCODE" }
$arguments = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/verify-windows-package.ps1",
    "-ExpectedCodeSha", $actual, "-BuildStartedAtUtc", $buildStarted.ToString("o"), "-DistDir", $distPath
)
if ($SkipSmokeTest) { $arguments += "-SkipSmokeTest" }
if ($SkipLifecycle) { $arguments += "-SkipLifecycle" }
& powershell.exe @arguments
if ($LASTEXITCODE -ne 0) { throw "Windows package verification failed: $LASTEXITCODE" }
