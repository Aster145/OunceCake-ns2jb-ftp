@echo off
setlocal
cd /d "%~dp0"
if not defined OUNCECAKE_NS2JB_HOST if exist "%~dp0LOCAL-HOST-PATH.txt" set /p "OUNCECAKE_NS2JB_HOST="<"%~dp0LOCAL-HOST-PATH.txt"
if not defined OUNCECAKE_NS2JB_HOST set "OUNCECAKE_NS2JB_HOST=%~dp0ns2jb-host"
if not exist "%OUNCECAKE_NS2JB_HOST%\run.cjs" (
  echo First run: node prepare-ns2jb.cjs "path-to-your-ns2jb-ftp"
  pause
  exit /b 1
)
node "%OUNCECAKE_NS2JB_HOST%\run.cjs" --rpc %*
set "ounce_exit=%errorlevel%"
pause
exit /b %ounce_exit%
