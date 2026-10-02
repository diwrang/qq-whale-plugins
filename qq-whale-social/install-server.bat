@echo off
setlocal
echo Run this installer on the production server.
echo Target: "%LOCALAPPDATA%\Programs\QQ Agent"
echo Close QQ Agent including its tray icon before installing.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Target "%LOCALAPPDATA%\Programs\QQ Agent"
set "INSTALL_RESULT=%ERRORLEVEL%"
pause
exit /b %INSTALL_RESULT%
