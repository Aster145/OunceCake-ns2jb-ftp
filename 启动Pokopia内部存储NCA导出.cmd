@echo off
setlocal
title OunceCake - Pokopia Internal NCA Export
call "%~dp0OUNCECAKE-POKOPIA-NCA.cmd" %*
exit /b %errorlevel%
