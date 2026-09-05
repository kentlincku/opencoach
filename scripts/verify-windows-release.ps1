param([string]$Directory = "dist")
$ErrorActionPreference = "Stop"
$executables = Get-ChildItem -Path $Directory -Filter *.exe -File
if (-not $executables) { throw "No Windows release executables found in $Directory" }
foreach ($executable in $executables) {
    $signature = Get-AuthenticodeSignature $executable.FullName
    if ($signature.Status -ne "Valid") {
        throw "Invalid Authenticode signature for $($executable.Name): $($signature.Status)"
    }
    Write-Host "Valid Authenticode signature: $($executable.Name)"
}
