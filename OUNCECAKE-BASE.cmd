@echo off
setlocal
cd /d "%~dp0"
node "%~dp0ouncecake.cjs" --ns2jb "%~dp0ns2jb-host" --base-only %*
set "ounce_exit=%errorlevel%"
pause
exit /b %ounce_exit%
