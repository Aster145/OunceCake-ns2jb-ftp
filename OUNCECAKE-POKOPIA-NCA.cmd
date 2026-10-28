@echo off
setlocal
cd /d "%~dp0"
title OunceCake - Pokopia Internal NCA Export
if not defined OUNCECAKE_NS2JB_HOST if exist "%~dp0LOCAL-HOST-PATH.txt" set /p "OUNCECAKE_NS2JB_HOST="<"%~dp0LOCAL-HOST-PATH.txt"
if not defined OUNCECAKE_NS2JB_HOST set "OUNCECAKE_NS2JB_HOST=%~dp0ns2jb-host"
if not exist "%OUNCECAKE_NS2JB_HOST%\run.cjs" (
  echo Host folder not found. Set LOCAL-HOST-PATH.txt to your existing ns2jb-host folder.
  pause
  exit /b 1
)
echo Close the previous OunceCake FTP window with q and wait for Stopped.
echo Keep NS2JB-RPC and SmileBASIC running. Wait for RPC ready before starting.
echo This exports Pokopia NCA files from internal storage over read-only FTP.
node "%~dp0ouncecake.cjs" --ns2jb "%OUNCECAKE_NS2JB_HOST%" 0400A3A01EE4C000 --installed-nca %*
set "ounce_exit=%errorlevel%"
pause
exit /b %ounce_exit%
