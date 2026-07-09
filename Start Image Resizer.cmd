@echo off
setlocal enabledelayedexpansion
title Image Resizer
cd /d "%~dp0"

set PORT=3210
if exist ".env" (
  for /f "usebackq tokens=1,2 delims==" %%A in (".env") do (
    if /i "%%A"=="PORT" set PORT=%%B
  )
)

echo ============================================
echo   Image Resizer
echo   Starting server on http://localhost:%PORT%
echo.
echo   Close this window (or press Ctrl+C) to
echo   stop the server.
echo ============================================
echo.

start "" cmd /c "timeout /t 2 >nul & start "" http://localhost:%PORT%"

node server.js

echo.
echo Server stopped.
pause >nul
