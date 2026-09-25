# 文件夹 ZIP、合辑打包与本机目录镜像

> **源码基线 Commit**：`b422e438fe50f78fdacd84ac1dff34a30a3d43ba`  
> **文档更新时间**：`2026-09-26`

## 1. 模块定位

Drop2Tunnel 有三类都使用 ZIP 的功能，但语义不同：

1. 发送一个本机文件夹；
2. 把合辑中已缓存文件打成 ZIP 下载；
3. 用 File System Access API 做本机目录镜像同步。

共同的基础模块：

`client/folder-archive.js`

不要把这套普通 ZIP helper 与网页工坊 `.html.zip` Runtime 混为一谈。

## 2. FolderArchive

全局对象：

`window.FolderArchive`

导出：

- `createZip(files)`
- `extractZip(blob)`

### 2.1 Path normalization

`normalizePath()`：

- `\` 转 `/`；
- 丢弃空 segment；
- 丢弃 `.`；
- 丢弃 `..`；
- 保持目录末尾 `/`。

主要目标是避免打包/解包时出现明显 traversal path。

## 3. ZIP 创建

当前创建器自己写：

- local file header；
- central directory；
- end of central directory；
- CRC32。

创建的 entry 使用：

- UTF-8 filename flag；
- compression method 0，即 Store / 不压缩。

这意味着它更偏向简单、浏览器端可控、无需额外 ZIP library，而不是追求最高压缩率。

## 4. ZIP 解包

`extractZip()`：

1. 从尾部寻找 EOCD；
2. 读取 central directory；
3. 定位 local header；
4. 提取文件。

当前支持：

- method 0：Store；
- method 8：Deflate，前提是浏览器支持 `DecompressionStream('deflate-raw')`。

如果浏览器没有 Deflate 解压能力，会明确报错。

## 5. 发送文件夹

`sendFolder(files)`：

1. 从 `webkitRelativePath` 确定 folder name；
2. `FolderArchive.createZip()`；
3. 生成：
   `<folderName>.zip`
4. 复用普通 `sendFile()`；
5. 额外 metadata：
   - `isFolderArchive: true`
   - `folderName`
   - `entryCount`

因此“发送文件夹”在传输层仍然是一个普通 file asset，只是带目录语义 metadata。

## 6. 合辑“下载全部”

`downloadCollectionFiles()` 也复用 `FolderArchive.createZip()`。

流程：

1. 收集当前已经完整缓存的 collection entries；
2. 如果有缺失文件，先请求恢复；
3. 显示等待/打包对话框；
4. 最长等待一段时间；
5. 用户可跳过仍缺失项目；
6. 对现有缓存做 ZIP；
7. 如果不完整，文件名会带“部分 N of M”。

这符合用户需求：

> 不必因为一个缺失成员，让已经可用的几十个文件完全无法下载。

## 7. 目录镜像

这是比“发送文件夹”更强的 Chromium 特性。

入口使用：

`showDirectoryPicker({ mode: 'readwrite' })`

要求 File System Access API。

不支持时明确提示 Firefox/移动浏览器使用普通“发送文件夹”。

## 8. 目录签名

系统递归枚举目录文件，签名包含：

- path；
- size；
- lastModified。

排序后拼接成 signature。

目录镜像约每 5 秒检查一次：

- signature 没变化 → 不发送；
- 变化 → 创建 snapshot ZIP。

## 9. Mirror Snapshot

变更时生成：

`<directoryName>-snapshot.zip`

作为普通 file asset 发送，但 metadata 标记：

- `isFolderArchive: true`
- `isDirectoryMirror: true`
- `folderName`
- `entryCount`
- `silent: true`

silent 的目的不是让数据“不存在”，而是避免每轮目录镜像都像用户主动文件发送一样制造普通干扰 UI。

## 10. 应用远端目录快照

`applyDirectoryMirrorAsset()`：

1. 校验当前本机确实挂载了同名 mirror directory；
2. 解压 asset；
3. 对 ZIP path 分段；
4. `getDirectoryHandle(..., {create:true})`；
5. `getFileHandle(..., {create:true})`；
6. createWritable；
7. 写 byte；
8. 重新扫描本机目录；
9. 更新本地 signature；
10. 设置 `skipSignature` 防止刚应用的远端变更立即又被回发一遍。

## 11. 当前镜像语义的限制

当前更接近“snapshot apply”，不是完整双向文件系统同步引擎。

文档不能暗示已经处理所有高级问题，例如：

- rename detection；
- delete tombstone；
- 同时两边编辑冲突；
- 文件锁；
- 大目录增量 delta；
- 权限/ACL；
- symlink。

修改目录镜像前应先明确是否要从 snapshot 机制升级，而不是默默引入另一套语义。

## 12. 与网页工坊 ZIP 的区别

FolderArchive：

- 一般文件/目录搬运；
- 不关心网页入口；
- 不创建 Runtime；
- 不处理 HTML resource root。

网页工坊：

- `.html.zip`；
- 有 draft；
- 有 WebZipRuntime；
- 有 Service Worker；
- 有 edit/publish 权限。

两者可以共享“ZIP 字节”概念，但不能把状态模型合并。

## 13. 安全与兼容

- ZIP path 会去除 `..`；
- directory mirror 写文件时也再次按 segment 过滤；
- Deflate 解压取决于浏览器 API；
- 大文件夹打包会在浏览器内占用内存；
- 当前 ZIP create 不压缩，大小大致接近原数据；
- mirror 需要 Chromium File System Access。

后续如果换第三方 ZIP 库，需要保持 path safety 和 metadata 兼容。
