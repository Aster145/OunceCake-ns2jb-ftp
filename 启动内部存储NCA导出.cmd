@echo off
setlocal
title OunceCake - Internal NCA Export
call "%~dp0OUNCECAKE-INSTALLED-NCA.cmd" %*
exit /b %errorlevel%
