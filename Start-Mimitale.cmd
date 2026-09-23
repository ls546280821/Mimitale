@echo off
rem ===========================================================================
rem  Start-Mimitale.cmd  --  double-click this to launch Mimitale.
rem
rem  Deliberately ASCII-only: cmd.exe decodes .cmd/.bat bytes using the active
rem  code page and re-reads the file as it executes, so non-ASCII characters in
rem  this file (or in a filename on a later line) can be mis-read and produce a
rem  bogus "file not found". The Chinese messages live in Start-Mimitale.ps1.
rem ===========================================================================

cd /d "%~dp0"
title Mimitale

where node >nul 2>nul
if errorlevel 1 goto :nonode

where npm >nul 2>nul
if errorlevel 1 goto :nonpm

set "PS1=%~dp0Start-Mimitale.ps1"
if not exist "%PS1%" goto :nops1

where powershell >nul 2>nul
if errorlevel 1 goto :nops

powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
exit /b %errorlevel%

:nonode
echo ==========================================================
echo  [ERROR] Node.js was not found.
echo.
echo  Please install the LTS version from https://nodejs.org
echo  Keep the default options, then restart your computer and
echo  double-click this file again.
echo ==========================================================
echo.
pause
exit /b 1

:nonpm
echo ==========================================================
echo  [ERROR] node was found, but npm was not.
echo  Your Node.js install looks incomplete. Please reinstall it.
echo ==========================================================
echo.
pause
exit /b 1

:nops1
echo ==========================================================
echo  [ERROR] Start-Mimitale.ps1 was not found next to this file.
echo  Keep both launchers in the same folder as package.json.
echo ==========================================================
echo.
pause
exit /b 1

:nops
echo ==========================================================
echo  [ERROR] powershell.exe was not found on this system.
echo.
echo  Open a command prompt in this folder and run manually:
echo      npm install
echo      npm start
echo ==========================================================
echo.
pause
exit /b 1
