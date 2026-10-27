@echo off
setlocal
cd /d "%~dp0"
if not defined OUNCECAKE_NS2JB_HOST if exist "%~dp0LOCAL-HOST-PATH.txt" set /p "OUNCECAKE_NS2JB_HOST="<"%~dp0LOCAL-HOST-PATH.txt"
if not defined OUNCECAKE_NS2JB_HOST set "OUNCECAKE_NS2JB_HOST=%~dp0ns2jb-host"
node "%~dp0ouncecake.cjs" --ns2jb "%OUNCECAKE_NS2JB_HOST%" --base-only %*
set "ounce_exit=%errorlevel%"
pause
exit /b %ounce_exit%
