@echo off
rem bili 后端薄包装：转发到 bili.ps1（由 PowerShell 脚本查找/下载 Node.js）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bili.ps1" %*
exit /b %ERRORLEVEL%
