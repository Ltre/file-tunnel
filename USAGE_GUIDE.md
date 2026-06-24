# 即时传输隧道 - 使用指南

## 部署说明

### 1. 基本部署
```bash
cd tunnel
npm install
npm start
```

服务器将在 `http://localhost:3000` 启动。

### 2. 外网访问配置
如果需要外网访问，确保防火墙开放相应端口：

```bash
# Windows 防火墙命令
netsh advfirewall firewall add rule name="Tunnel Port 3000" dir=in action=allow protocol=tcp localport=3000
```

### 3. 域名配置
编辑 `server.js` 中的 `ALLOWED_ORIGINS` 配置：

```javascript
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS 
    ? process.env.ALLOWED_ORIGINS.split(',') 
    : [
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'https://your-domain.com',  // 替换为你的域名
        'https://your-domain.com:3000'
      ];
```

## 功能使用

### 1. 文件传输
- **小文件** (≤ 5MB): 直接通过 Socket.io 传输，立即发送
- **大文件** (> 5MB): 通过 P2P (WebRTC) 传输，需要接收方确认

### 2. 协同编辑
- 多人可以同时编辑右侧的富文本区域
- 内容会实时同步到所有连接的设备
- 支持格式化文本、插入图片和引用文件

### 3. 会话管理
- 通过二维码或直接访问带 hash 的 URL 加入会话
- 同一会话内的所有设备可以相互传输文件和消息
- 最多支持 10 个设备同时连接

## 安全特性

### 1. 数据安全
- 所有文件和消息仅存储在浏览器本地 (IndexedDB)
- 不上传到服务器
- 传输过程中数据加密

### 2. 访问控制
- CORS 限制防止跨域访问
- 速率限制防止单 IP 过度使用
- 会话隔离确保不同会话数据分离

### 3. P2P 传输
- 大文件通过 WebRTC 直接传输，不经过服务器
- 需要接收方确认才开始传输

## 管理后台

访问 `http://your-domain:3000/admin` 查看：

- 当前活跃隧道列表（会话列表）
- 在线设备统计
- 隧道管理功能（会话管理功能）

## 故障排除

### 1. P2P 连接失败
- 检查浏览器是否支持 WebRTC
- 确认网络环境支持 P2P 连接
- 尝试使用 HTTPS (在某些浏览器中必要)

### 2. 文件传输失败
- 检查文件大小是否超出限制
- 确认接收方已同意接收大文件
- 检查网络连接稳定性

### 3. 协同编辑不同步
- 确认所有设备连接到同一会话
- 检查网络连接状态
- 刷新页面重新同步

## API 接口

### 获取会话信息
```
GET /api/sessions
```

### 管理后台
```
GET /admin
```

## 技术架构

- **前端**: HTML5, JavaScript (ES6+), IndexedDB
- **后端**: Node.js, Express, Socket.io
- **传输协议**: WebSocket (小文件), WebRTC (大文件)
- **存储**: 浏览器 IndexedDB (本地), Socket.io (信令)

## 支持的浏览器

- Chrome 80+
- Firefox 75+
- Safari 14+
- Edge 80+

注意: 部分功能在 HTTP 环境下可能受限，建议使用 HTTPS。

## 日志

http://10.0.0.16:3000/api/debug-logs?limit=1000