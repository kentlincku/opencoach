# Verify Windows local providers (Ollama, llama.cpp, and LM Studio) through ProviderBroker.
$ErrorActionPreference = "Stop"

Write-Host "==> Probing live loopback providers through ProviderBroker"
Write-Host "    llama.cpp expected endpoint: http://127.0.0.1:8080/v1"
$expectedLlamaCppModel = if ($env:LLAMACPP_MODEL) { $env:LLAMACPP_MODEL } else { 'ornith-9b' }
Write-Host "    llama.cpp expected model: $expectedLlamaCppModel"

$scriptPath = Join-Path $PSScriptRoot "verify-windows-local-providers.cjs"
$output = node $scriptPath 2>&1
$exitCode = $LASTEXITCODE
$output | Write-Host

if ($exitCode -ne 0) {
    throw "Live local provider verification script failed with exit code $exitCode"
}

Write-Host "`n==> Live local provider check completed (exit code 0)"
