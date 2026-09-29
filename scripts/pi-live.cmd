@echo off
setlocal
set "HERE=%~dp0"
where bun >nul 2>nul && bun "%HERE%pi-live.mjs" %* && exit /b %ERRORLEVEL%
where node >nul 2>nul && node "%HERE%pi-live.mjs" %* && exit /b %ERRORLEVEL%
echo need bun or node to open the live dashboard
exit /b 1
