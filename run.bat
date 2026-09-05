@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Voice Practice - AI English Coach

where npm >nul 2>nul
if errorlevel 1 (
    echo Node.js/npm is required. Install Node.js, then run run.bat again.
    goto :fail
)

if not exist ".venv\Scripts\python.exe" goto :setup
if not exist "node_modules\.bin\electron.cmd" goto :setup
if not exist ".runtime\kokoro-onnx\kokoro-v1.0.int8.onnx" goto :setup
if not exist ".runtime\kokoro-onnx\voices-v1.0.bin" goto :setup
powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\scripts\setup-windows.ps1" -VerifyAssetsOnly
if errorlevel 1 goto :setup
goto :launch

:setup
echo Preparing Voice Practice Desktop for first use...
powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\scripts\setup-windows.ps1"
if errorlevel 1 goto :fail

:launch
set "VOICE_RUNTIME_PYTHON=%CD%\.venv\Scripts\python.exe"
if not defined VOICE_STT_BACKEND set "VOICE_STT_BACKEND=auto"
if not defined VOICE_TTS_BACKEND set "VOICE_TTS_BACKEND=auto"
if not defined VOICE_FASTER_WHISPER_MODEL set "VOICE_FASTER_WHISPER_MODEL=base.en"
if not defined VOICE_FASTER_WHISPER_DEVICE set "VOICE_FASTER_WHISPER_DEVICE=auto"
if not defined VOICE_FASTER_WHISPER_COMPUTE_TYPE set "VOICE_FASTER_WHISPER_COMPUTE_TYPE=int8"
set "VOICE_KOKORO_ONNX_MODEL=%CD%\.runtime\kokoro-onnx\kokoro-v1.0.int8.onnx"
set "VOICE_KOKORO_ONNX_VOICES=%CD%\.runtime\kokoro-onnx\voices-v1.0.bin"

echo Starting Voice Practice Desktop...
call npm start
if errorlevel 1 goto :fail
exit /b 0

:fail
echo.
echo Voice Practice could not start.
pause
exit /b 1
