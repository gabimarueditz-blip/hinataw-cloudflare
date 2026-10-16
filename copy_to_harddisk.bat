@echo off
rem Copy the project to a permanent location (e.g., Documents)
set "DEST=%USERPROFILE%\Documents\9Anime"
if not exist "%DEST%" mkdir "%DEST%"
xcopy /E /I /Y "%~dp0" "%DEST%"
echo Project copied to %DEST%
pause
