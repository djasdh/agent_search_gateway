@echo off
@rem agent_search_gateway 自更新入口（Windows 命令提示符）
@rem 仅负责转发到 PowerShell 脚本，实际逻辑在 windows.ps1 与 cli.mjs 中。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows.ps1" %*
exit /b %ERRORLEVEL%
