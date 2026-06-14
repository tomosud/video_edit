@echo off
REM ViralCut local server
cd /d "%~dp0"
echo.
echo   ViralCut - open http://localhost:8000 in Chrome or Edge
echo.
python -m http.server 8000
