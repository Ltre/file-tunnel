@echo off
title 即时传输隧道服务器

echo 🚀 启动即时传输隧道服务器...

REM 检查 Node.js 是否已安装
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Node.js 未安装，请先安装 Node.js
    pause
    exit /b 1
)

REM 检查依赖是否已安装
if not exist "node_modules" (
    echo 📦 安装依赖...
    npm install
    if %errorlevel% neq 0 (
        echo ❌ 依赖安装失败
        pause
        exit /b 1
    )
)

echo 🌐 服务器将在 http://localhost:3000 启动
echo 💡 提示：外网访问请使用服务器公网IP:3000
echo.

REM 启动服务器
node server.js