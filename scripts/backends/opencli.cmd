@echo off
rem opencli 后端薄包装：转发到 opencli.ps1（由 PowerShell 脚本查找/下载 Node.js）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0opencli.ps1" %*
exit /b %ERRORLEVEL%
