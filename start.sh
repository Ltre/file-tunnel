#!/bin/bash

# 即时传输隧道 - 启动脚本

echo "🚀 启动即时传输隧道服务器..."

# 检查 Node.js 是否已安装
if ! command -v node &> /dev/null; then
    echo "❌ Node.js 未安装，请先安装 Node.js"
    exit 1
fi

# 检查依赖是否已安装
if [ ! -d "node_modules" ]; then
    echo "📦 安装依赖..."
    npm install
    if [ $? -ne 0 ]; then
        echo "❌ 依赖安装失败"
        exit 1
    fi
fi

echo "🌐 服务器将在 http://localhost:3000 启动"
echo "💡 提示：外网访问请使用服务器公网IP:3000"

# 启动服务器
node server.js