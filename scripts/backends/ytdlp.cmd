@echo off
rem ytdlp 后端薄包装：转发到 ytdlp.ps1（由 PowerShell 脚本查找/下载 Node.js）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ytdlp.ps1" %*
exit /b %ERRORLEVEL%
