@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo 需要先安装 Node.js 24 或更高版本：https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo 首次运行：正在安装依赖，请稍候……
  call npm install
  if errorlevel 1 (
    echo 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

node scripts\launch.mjs %*
if errorlevel 1 pause
