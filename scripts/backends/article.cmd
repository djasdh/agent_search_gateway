@echo off
rem article 后端薄包装：转发到 article.ps1（由 PowerShell 脚本查找/下载 Node.js）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0article.ps1" %*
exit /b %ERRORLEVEL%
