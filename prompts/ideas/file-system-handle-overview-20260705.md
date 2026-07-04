研究这两个需求 
支持虚拟目录映射到文件系统的真实目录、支持虚拟文件映射到系统具体文件路径。



这两个需求可以做，但要先定清楚**两种实现层级**：

```text id="q47jc9"
PWA/网页层：虚拟目录/文件 只能映射到用户授权过的 FileSystemHandle，不能直接绑定任意系统绝对路径。
本地助手/Node 层：可以把虚拟目录/文件映射到真实系统路径，例如 D:\Music、/home/user/Downloads/a.mp4。
```

所以这两个需求最合理的产品定义是：

> **虚拟资源映射：在 file-tunnel 内创建一个虚拟目录树，目录或文件节点可以指向浏览器本地缓存、用户授权目录、用户授权文件、服务端文件、Telegram server asset，或本地助手暴露的真实系统路径。**

---

# 一、先说结论

## 10、支持虚拟目录映射到文件系统真实目录

可以做。

但在 PWA 里，应该叫：

```text id="9veqdu"
虚拟目录 → 用户授权目录句柄
```

而不是：

```text id="f6nka5"
虚拟目录 → C:\Users\xxx\Downloads
```

因为网页不能随意读取系统路径。浏览器 File System Access API 允许 Web App 在用户授权后读写本地文件和目录，Chrome 文档明确说该 API 可让 Web App 直接读取或保存本地设备上的文件和文件夹。([Chrome for Developers][1]) 但 `showDirectoryPicker()` 需要 HTTPS 安全上下文，而且 MDN 标注它并非 Baseline、仍需注意浏览器兼容性。([MDN 網路文件][2])

所以 PWA 版能做到：

```text id="rh28ws"
用户点击“映射真实目录”
↓
浏览器弹出目录选择器
↓
用户选择 D:\Music 或 /Users/me/Music
↓
PWA 获得 FileSystemDirectoryHandle
↓
把这个 handle 存到 IndexedDB
↓
file-tunnel 内显示为 /我的音乐
```

不能做到：

```text id="0ozk2b"
用户不授权，PWA 直接扫描 D:\Music
PWA 直接记录和使用真实绝对路径
PWA 后台静默访问任意系统目录
```

---

## 11、支持虚拟文件映射到系统具体文件路径

也可以做，但 PWA 版应该叫：

```text id="3m26av"
虚拟文件 → 用户授权文件句柄
```

例如：

```text id="vhwklm"
/我的音乐/周杰伦/晴天.mp3
    ↓
FileSystemFileHandle
    ↓
用户本机真实文件
```

PWA 不应该依赖真实路径字符串，而应该依赖浏览器给的 `FileSystemFileHandle`。MDN 说明 File System API 通过 `FileSystemFileHandle` 和 `FileSystemDirectoryHandle` 这两类 handle 表示用户系统上的文件和目录，用户通过文件/目录 picker 授权后才获得 handle。([MDN 網路文件][3])

---

# 二、这两个需求的真正价值

这两个功能对 file-tunnel 很有价值，因为它可以把 file-tunnel 从：

```text id="w5guta"
把文件复制进隧道缓存
```

升级为：

```text id="tw7xkp"
把真实文件系统的一部分挂到隧道资源树里
```

也就是：

```text id="0emokh"
虚拟目录
  ├─ 本地真实目录
  ├─ 本地真实文件
  ├─ IndexedDB 缓存文件
  ├─ Telegram server asset
  ├─ 远端设备可提供资源
  └─ 合辑/传输记录引用
```

这样以后 file-tunnel 的资源浏览器就不只是“看缓存文件”，而是变成一个**轻量虚拟文件系统**。

---

# 三、建议命名

不要直接叫“真实目录映射”，用户会担心安全。

建议 UI 文案：

```text id="7xqpd2"
挂载本机目录
```

或者：

```text id="22lg2z"
添加本机目录
```

虚拟文件可以叫：

```text id="7muy80"
关联本机文件
```

整体功能名：

```text id="3siv5s"
本机资源映射
```

或：

```text id="8nhyk9"
虚拟资源挂载
```

我最推荐：

```text id="b4i792"
本机资源挂载
```

因为“挂载”这个词对懂技术的人很准确；普通用户看到“本机资源”也能大概理解。

---

# 四、PWA 版实现方式

## 1. 虚拟目录映射

用户在资源浏览器点击：

```text id="2iejxw"
添加本机目录
```

浏览器调用：

```js id="rcv2jw"
const dirHandle = await window.showDirectoryPicker({
  mode: 'readwrite'
});
```

`showDirectoryPicker()` 会返回 `FileSystemDirectoryHandle`，并且可以传 `mode: "read"` 或 `"readwrite"` 控制读写权限。([MDN 網路文件][2])

然后保存到 IndexedDB：

```js id="m0njeo"
await db.localMounts.put({
  id: mountId,
  type: 'directory',
  virtualPath: '/本机音乐',
  displayName: '本机音乐',
  handle: dirHandle,
  permissionMode: 'readwrite',
  createdAt: Date.now(),
  updatedAt: Date.now()
});
```

Chrome 文档明确说明 file handles 和 directory handles 是可序列化的，可以保存到 IndexedDB，也可以在同一顶级 origin 内通过 `postMessage()` 传递。([Chrome for Developers][1])

以后重新打开 PWA 时，从 IndexedDB 取出 handle，再验证权限：

```js id="0x5rdx"
async function verifyPermission(handle, mode = 'read') {
  const options = { mode };
  if ((await handle.queryPermission(options)) === 'granted') {
    return true;
  }
  return (await handle.requestPermission(options)) === 'granted';
}
```

注意：权限不一定跨 session 持久保留，Chrome 文档建议每次使用已保存 handle 前用 `queryPermission()` 检查，不够权限时再 `requestPermission()` 请求。([Chrome for Developers][1])

---

## 2. 虚拟文件映射

用户点击：

```text id="dnj2dw"
关联本机文件
```

调用：

```js id="kvh2aj"
const [fileHandle] = await window.showOpenFilePicker();
```

保存：

```js id="6x7kd5"
await db.localMounts.put({
  id: mountId,
  type: 'file',
  virtualPath: '/我的文件/说明书.pdf',
  displayName: '说明书.pdf',
  handle: fileHandle,
  permissionMode: 'read',
  createdAt: Date.now(),
  updatedAt: Date.now()
});
```

读取：

```js id="wi6vey"
const file = await fileHandle.getFile();
```

如果要支持写回真实文件，就需要请求 `readwrite` 权限，并通过 `createWritable()` 写入。

---

# 五、PWA 版的最大限制

## 1. 不能稳定知道真实绝对路径

PWA 只能拿到 handle 和文件名/目录名，不能可靠拿到：

```text id="9vyehx"
D:\Music\A\song.mp3
/Users/me/Music/A/song.mp3
/storage/emulated/0/Download/a.zip
```

这是隐私设计。

所以数据库里不要设计成：

```js id="d14xfp"
realPath: "D:\\Music\\song.mp3"
```

而应该是：

```js id="vil2y4"
handle: FileSystemFileHandle
```

UI 上最多显示：

```text id="8eggb6"
本机授权文件：song.mp3
来源：用户授权
```

不要承诺显示完整系统路径。

---

## 2. 权限可能丢

即使 handle 存在，权限也可能从 `granted` 变成 `prompt` 或 `denied`。所以所有虚拟目录/文件都要有状态：

```text id="wrzhzx"
可访问
需要重新授权
权限被拒绝
目标不存在或已移动
```

---

## 3. 浏览器兼容不完整

MDN 对 `showDirectoryPicker()` 标注为 limited availability，并指出它不适用于部分主流浏览器。([MDN 網路文件][2]) 所以这功能在 Chromium 桌面/部分 Android 上比较适合；iOS Safari / Firefox 不能指望完整支持。

因此 UI 要有降级：

```text id="v7s9vn"
当前浏览器不支持本机目录挂载，请改用上传文件、拖拽文件夹或安装桌面助手。
```

---

# 六、和 OPFS 的区别

file-tunnel 现在大量依赖 IndexedDB 缓存，后续也可能考虑 OPFS。OPFS 是 origin private file system，也就是浏览器给当前网站的一块私有文件系统；MDN 说明 OPFS 对页面 origin 私有，不像普通文件系统那样对用户可见。([MDN 網路文件][3]) Chrome 文档也说明 OPFS 的内容不应期望能在硬盘上找到一一对应的真实文件。([Chrome for Developers][1])

所以要分清：

```text id="28z9sm"
OPFS / IndexedDB 缓存：
  文件属于 file-tunnel 的浏览器私有缓存。

本机目录挂载：
  文件属于用户真实文件系统，file-tunnel 只是拿到了授权 handle。

服务端资产：
  文件在服务器 .tunnel-data 目录。

远端设备资源：
  文件在别的设备缓存里，需要对方在线才能拉取。
```

---

# 七、建议的数据模型

## 1. 本地挂载表

```js id="2k6zu5"
LocalMount {
  id: string,
  deviceId: string,
  sessionId?: string,

  kind: 'directory' | 'file',
  virtualPath: string,
  displayName: string,

  sourceType: 'fs-access-handle' | 'opfs' | 'indexeddb-cache' | 'local-helper' | 'server-asset',

  handle?: FileSystemFileHandle | FileSystemDirectoryHandle,

  permissionMode: 'read' | 'readwrite',
  permissionState: 'unknown' | 'granted' | 'prompt' | 'denied',

  scope: 'device' | 'tunnel',
  isSharedToTunnel: boolean,

  createdAt: number,
  updatedAt: number,
  lastCheckedAt?: number,
  lastAccessedAt?: number
}
```

说明：

```text id="v4m6vv"
device scope：只在当前设备显示。
tunnel scope：在当前隧道资源树里显示，但真实文件仍只存在于当前设备。
```

---

## 2. 虚拟节点表

```js id="b38dgu"
VirtualResourceNode {
  id: string,
  parentId?: string,

  name: string,
  virtualPath: string,
  nodeType: 'directory' | 'file',

  mountId?: string,
  assetId?: string,

  sourceType:
    | 'mounted-directory'
    | 'mounted-file'
    | 'cached-asset'
    | 'server-asset'
    | 'remote-provider'
    | 'collection-file',

  fileMeta?: {
    name: string,
    size: number,
    mimeType: string,
    lastModified?: number,
    extension?: string
  },

  capabilities: {
    read: boolean,
    write: boolean,
    delete: boolean,
    rename: boolean,
    download: boolean,
    preview: boolean,
    shareToTunnel: boolean
  },

  status:
    | 'available'
    | 'needs-permission'
    | 'missing'
    | 'remote-only'
    | 'cached'
    | 'syncing'
    | 'error',

  createdAt: number,
  updatedAt: number
}
```

---

## 3. 路径映射表

用于快速从虚拟路径查到真实来源：

```js id="go9ci2"
VirtualPathMapping {
  id: string,
  virtualPath: string,

  targetType:
    | 'fs-directory-handle'
    | 'fs-file-handle'
    | 'indexeddb-file-cache'
    | 'server-file-path'
    | 'helper-real-path',

  targetRef: string,
  mountId?: string,
  assetId?: string,

  deviceId: string,
  tunnelId?: string,

  readOnly: boolean,
  createdAt: number,
  updatedAt: number
}
```

PWA 里 `targetRef` 不应该是系统真实路径，而是 mountId / assetId / handle key。

本地助手版才可以用：

```js id="m6hrwt"
targetRef: "D:\\Music\\Jay\\晴天.mp3"
```

---

# 八、资源浏览器 UI 应该怎么表现

## 1. 资源浏览器顶部新增入口

```text id="xqjcpz"
[添加本机目录] [关联本机文件] [新建虚拟目录]
```

## 2. 目录树示例

```text id="7vlxre"
资源
├─ 隧道文件
│  ├─ 图片
│  ├─ 视频
│  └─ 合辑
├─ 本机挂载
│  ├─ 我的音乐       本机目录
│  ├─ 下载目录       本机目录
│  └─ 说明书.pdf     本机文件
└─ Telegram 入站
   └─ 2026-07
```

## 3. 节点状态标签

```text id="0c3sdp"
本机目录
本机文件
本机缓存
远端可还原
服务端临时资产
需要授权
目标已移动
只读
可写
```

## 4. 文件操作

对挂载文件：

```text id="gsjkfp"
预览
发送到当前隧道
复制到隧道缓存
下载
解除映射
刷新状态
```

对挂载目录：

```text id="eu0yqf"
打开
扫描
发送整个目录
生成 ZIP 发送
同步目录快照
解除挂载
重新授权
```

这里要区分两个动作：

```text id="srj1m6"
解除映射：只删除 file-tunnel 里的虚拟节点，不删除真实文件。
删除真实文件：危险操作，需要额外确认。
```

默认第一版不要做删除真实文件。

---

# 九、虚拟目录如何映射真实目录

## 模式 A：只读挂载

最安全，第一版推荐。

```text id="c0tga9"
虚拟目录 /我的音乐
↓
用户授权 D:\Music
↓
file-tunnel 枚举文件
↓
点击文件时按需读取
↓
发送时读取文件内容并走现有传输链路
```

优点：

```text id="nbqcx5"
风险低
不会误删真实文件
适合媒体库
适合文件发送
```

## 模式 B：读写挂载

用于接收文件直接落到真实目录。

```text id="swugqi"
虚拟目录 /手机收件箱
↓
映射到 D:\Receive
↓
别的设备发送文件
↓
当前设备接收完成后写入 D:\Receive
```

这个很有价值，但需要 `readwrite` 权限。Chrome 文档说明如果需要目录写权限，可在 `showDirectoryPicker()` 传 `{ mode: 'readwrite' }`。([Chrome for Developers][1])

UI 必须提示：

```text id="gpk2i1"
允许 file-tunnel 向此目录写入接收文件。
不会自动删除已有文件。
同名文件会自动重命名或询问覆盖。
```

## 模式 C：双向同步

暂时不建议第一版做。

因为涉及：

```text id="7hzrrw"
目录变更监听
冲突处理
删除同步
重命名识别
增量传输
断点续传
跨设备状态一致性
```

可以先叫：

```text id="8g1izb"
目录快照发送
```

不要叫完整同步。

---

# 十、虚拟文件如何映射真实文件

## 典型场景

```text id="kpifnl"
把 D:\Music\A.mp3 映射为 /音乐/A.mp3
把 /Users/me/Documents/id.pdf 映射为 /证件/id.pdf
把下载目录里的 setup.exe 映射为 /工具/setup.exe
```

点击虚拟文件时：

```text id="v1mmz8"
检查 handle 权限
↓
getFile()
↓
根据 MIME/扩展名预览
↓
需要发送时创建 file asset
↓
走现有缓存/P2P/relay/Telegram/合辑逻辑
```

注意：如果真实文件被外部程序修改，之前拿到的 `File` 对象可能失效；Chrome 文档指出 `getFile()` 返回的 `File` 只在底层文件未改变时可读，磁盘文件修改后需要重新调用 `getFile()` 获取新对象。([Chrome for Developers][1])

所以你应该每次实际读取前重新 `getFile()`，不要长期持有旧 Blob。

---

# 十一、和现有 file-tunnel 功能如何结合

## 1. 合辑

可以支持：

```text id="3pys5n"
把挂载目录中的多个文件选中
↓
按合辑发送
```

也可以：

```text id="9k5wgr"
把整个挂载目录打包成 ZIP
↓
作为一个文件发送
```

第一版建议：

```text id="sxitd2"
目录 → ZIP 发送
多文件选择 → 合辑发送
```

---

## 2. 媒体库

你之前提过“先在简陋媒体库中使用收藏标记筛选自己的媒体库”。

虚拟目录挂载非常适合媒体库：

```text id="890vg3"
挂载本机音乐目录
↓
扫描音频文件
↓
提取封面/标题/艺术家/专辑
↓
生成本地媒体库
↓
收藏标记
↓
全屏播放器随机续播
```

此时音乐不需要先复制进 IndexedDB。播放时按需从真实目录 handle 读取 Blob URL。

但要注意：PWA 页面刷新后，handle 还在 IndexedDB，但权限可能需要重新确认。

---

## 3. 传输记录

从挂载文件发送出去时，可以保留来源信息：

```js id="5g8d96"
fileInfo: {
  name,
  size,
  type,
  sourceKind: 'mounted-file',
  sourceMountId,
  sourceVirtualPath,
  originalLastModified
}
```

不要把真实路径广播给别的设备。

远端看到：

```text id="7p5psz"
来自 Ltre-PC 的本机挂载文件
```

不要显示：

```text id="f0m3al"
D:\私人目录\xxx
```

---

## 4. 资源浏览器

资源浏览器可以把挂载资源和缓存资源合并：

```text id="f1rzy5"
song.mp3
状态：本机挂载 · 可发送
引用：音乐库收藏、播放队列
操作：预览 / 发送 / 解除映射
```

---

# 十二、本地助手增强版

如果未来你做 localhost / Node helper，那么这两个需求会强很多。

本地助手可以暴露：

```http id="82n9pf"
GET  http://127.0.0.1:PORT/api/fs/list?path=D:\Music
GET  http://127.0.0.1:PORT/api/fs/file?path=D:\Music\a.mp3
POST http://127.0.0.1:PORT/api/fs/write
```

PWA 通过本地 WebSocket/HTTP 调用 helper：

```text id="9w25ov"
PWA UI
↓
127.0.0.1 helper
↓
真实文件系统
```

本地助手版可以支持：

```text id="cvfwhz"
真实绝对路径
后台扫描目录
文件变更监听
大文件流式读取
接收文件直接写入指定目录
断点续传分片落盘
系统托盘常驻
更稳定的媒体库
```

但安全要求也更高。

## helper 必须做权限白名单

不要让网页传任意 path 就读。

应该这样：

```js id="8tmm8c"
AllowedMount {
  id,
  label,
  realPath,
  virtualPath,
  mode: 'read' | 'readwrite',
  createdAt
}
```

PWA 只能访问已授权 mountId：

```http id="r63m6h"
GET /api/fs/mounts/:mountId/list?subpath=xxx
```

不能访问：

```http id="m0ehio"
GET /api/fs/file?path=C:\Windows\System32\config\SAM
```

---

# 十三、安全策略

## 1. 默认只读

第一版：

```text id="btv23t"
挂载目录默认只读。
```

写入真实目录、删除真实文件、覆盖真实文件都先不做，或者必须显式开启。

## 2. 虚拟路径不能穿越

必须禁止：

```text id="dkroqo"
../
..\ 
绝对路径
符号链接逃逸
```

对于本地助手尤其重要。

## 3. 不广播真实路径

真实路径只保存在当前设备：

```text id="x7u7bb"
D:\Music\secret.mp3
```

隧道内其它设备只看到：

```text id="6feazv"
/本机音乐/secret.mp3
来源设备：Ltre-PC
```

## 4. 删除语义分层

```text id="2w6hcn"
从虚拟目录移除：解除映射，不删真实文件。
清除缓存：删浏览器缓存，不删真实文件。
删除传输记录：删隧道消息，不删真实文件。
删除真实文件：危险操作，单独确认，第一版不建议做。
```

## 5. 权限状态可见

每个挂载目录要显示：

```text id="k1dcxi"
已授权
需要重新授权
只读
可写
不可用
```

---

# 十四、建议落地顺序

## P0：只做“本机目录挂载，只读浏览”

```text id="63glua"
添加本机目录
保存 directory handle 到 IndexedDB
资源浏览器显示虚拟目录
支持枚举文件
支持预览图片/视频/音频
支持发送单个文件
支持解除挂载
```

这是最稳的第一版。

---

## P1：虚拟文件映射

```text id="bhdmw0"
关联本机文件
保存 file handle
资源浏览器显示为一个虚拟文件
支持预览/发送/解除映射
```

---

## P2：挂载目录内多选发送

```text id="u7yxbs"
目录内多选文件
按合辑发送
或打包 ZIP 发送
```

---

## P3：接收文件写入挂载目录

```text id="4p4szp"
把某个虚拟目录设置为“收件箱”
接收文件完成后写入真实目录
同名自动重命名
```

需要 readwrite 权限。

---

## P4：媒体库挂载

```text id="5zfhdb"
挂载音乐目录
扫描音频元数据
生成本地媒体库
支持收藏筛选
支持随机续播
```

这个和你现在音乐播放器很契合。

---

## P5：本地助手增强

```text id="6l320f"
支持真实系统路径
后台目录监听
大文件流式读取/写入
断点续传落盘
自动同步目录快照
```

---

# 十五、具体需求改写建议

你这两条需求可以改成更准确、可开发的版本：

```text id="3pwrwc"
10、资源浏览器支持“本机目录挂载”：用户可主动选择一个本机真实目录，将其映射为 file-tunnel 内的虚拟目录。虚拟目录可浏览、预览、发送其中的文件；PWA 版通过 FileSystemDirectoryHandle 保存授权目录句柄，本地助手版可映射到真实系统路径。

11、资源浏览器支持“本机文件挂载”：用户可主动选择一个本机真实文件，将其映射为 file-tunnel 内的虚拟文件。虚拟文件可预览、发送、加入合辑或加入媒体库；PWA 版通过 FileSystemFileHandle 保存授权文件句柄，本地助手版可映射到真实系统路径。
```

---

# 十六、最终判断

这两个需求非常值得做，而且是 file-tunnel 后续“资源浏览器 / 媒体库 / 本地缓存 / 目录同步 / 本地助手”的关键底座。

我建议第一版不要做“任意系统路径映射”，而是做：

```text id="jnu7ev"
PWA 本机资源挂载：
  虚拟目录 → FileSystemDirectoryHandle
  虚拟文件 → FileSystemFileHandle
```

等这套虚拟资源模型稳定后，再用本地助手增强为：

```text id="4yxm40"
虚拟目录 → 真实系统目录路径
虚拟文件 → 真实系统文件路径
```

这样路线最稳，也不会踩浏览器权限和安全边界。

[1]: https://developer.chrome.com/docs/capabilities/web-apis/file-system-access "The File System Access API: simplifying access to local files  |  Capabilities  |  Chrome for Developers"
[2]: https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker "Window: showDirectoryPicker() method - Web APIs | MDN"
[3]: https://developer.mozilla.org/en-US/docs/Web/API/File_System_API "File System API - Web APIs | MDN"
