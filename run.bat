@echo off
title 9Anime - Ultra Anime Streaming Platform
cd /d "%~dp0"
echo ========================================================
echo   Starting 9Anime Streaming Platform
echo   Local Web Interface: http://localhost:3000
echo ========================================================

rem Start server in background
if exist "C:\Users\Dell\AppData\Roaming\Antigravity\bin\agy-node.cmd" (
    start "" "C:\Users\Dell\AppData\Roaming\Antigravity\bin\agy-node.cmd" server.js
) else (
    start "" cmd /c "node server.js"
)
rem Wait a moment for server to listen
timeout /t 2 > nul
rem Open browser after server start
start "" "http://localhost:3000"
pause
