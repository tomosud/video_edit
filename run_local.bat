@echo off
REM ViralCut local server
setlocal
cd /d "%~dp0"

set "START_PORT=%~1"
if "%START_PORT%"=="" set "START_PORT=8000"
set "HOST=127.0.0.1"

set "PORT="
for /l %%P in (%START_PORT%,1,8020) do (
  powershell -NoProfile -Command "$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Parse('%HOST%'), %%P); try { $listener.Start(); $listener.Stop(); exit 0 } catch { exit 1 }" >nul 2>nul
  if not errorlevel 1 (
    set "PORT=%%P"
    goto :start
  )
)


echo.
echo   ViralCut - no free port found from %START_PORT% to 8020
echo.
exit /b 1

:start
echo.
echo   ViralCut launcher: %~f0
echo   ViralCut - open http://%HOST%:%PORT% in Chrome or Edge
echo.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Milliseconds 700; Start-Process 'http://%HOST%:%PORT%/'"
python -m http.server %PORT% --bind %HOST%
