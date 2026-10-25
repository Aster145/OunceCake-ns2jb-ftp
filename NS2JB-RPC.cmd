@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0ns2jb-host\run.cjs" (
  echo First run: node prepare-ns2jb.cjs "path-to-your-ns2jb-ftp"
  pause
  exit /b 1
)
node "%~dp0ns2jb-host\run.cjs" --rpc %*
set "ounce_exit=%errorlevel%"
pause
exit /b %ounce_exit%
