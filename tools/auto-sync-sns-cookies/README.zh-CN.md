# Drop2Tunnel SNS Cookie 自动同步扩展

这是管理员自用的浏览器扩展。它会读取当前浏览器中受支持 SNS 平台的 Cookie（包括 HttpOnly Cookie），分别转换为 Netscape cookies.txt 格式，并通过专用鉴权接口批量同步到多台 Drop2Tunnel 服务器。当前分别提供 Chrome、Firefox Windows 和 Firefox Android 三个安装包目录。

支持的平台与 Cookie 域名：

- YouTube / YT Music：`youtube.com`；
- TikTok：`tiktok.com`；
- Facebook：`facebook.com`；
- Instagram：`instagram.com`；
- Threads：`threads.com`、旧域名 `threads.net`，并读取其可能复用的 `instagram.com` 登录态；
- LINE：`line.me`；
- Twitter / X：`twitter.com`、`x.com`。

同步后分别写入 `/sns-cookies` 页面列出的 `yt-cookies.txt`、`tiktok-cookies.txt`、`facebook-cookies.txt`、`instagram-cookies.txt`、`thread-cookies.txt`、`line-cookies.txt`、`twitter-cookies.txt` 和 `x-cookies.txt`。未登录或没有可用 Cookie 的平台会被跳过，不会删除或覆盖服务器中的原配置。

## 目录与构建

```text
tools/auto-sync-sns-cookies/
├─ chrome/             Chrome Manifest V3，也是公共 JS/HTML 的维护源
├─ firefox-windows/    Firefox Windows Manifest V3
├─ firefox-android/    Firefox Android Manifest V2
└─ build.mjs           将公共 JS/HTML 同步到两个 Firefox 目录
```

修改 `chrome/` 中的 `background.js`、`options.html`、`options.js` 或 `sns-opened.js` 后执行：

```bash
npm run build:sns-cookie-extension
```

构建脚本不会覆盖三个目录各自的 `manifest.json`。

旧版 Chrome 扩展直接从 `tools/auto-sync-sns-cookies` 根目录加载。迁移前请先用旧扩展“导出配置”，再加载新的 `chrome/` 目录并导入 Base64；目录变化可能让 Chrome 生成新的扩展 ID，因此不要假设旧本地配置会自动继承。三种浏览器包的本地存储也彼此独立，可用同一份 Base64 配置在不同浏览器间迁移。

## 安装与配置

1. 分别打开每台 Drop2Tunnel 服务器的 `/sns-cookies` 管理页，在“浏览器自动同步 SNS Cookie”区域生成各自的同步密钥。
2. 按下方对应浏览器的方式加载扩展。
3. 打开扩展，点击 `+`，填写一台服务器的地址和对应同步密钥；按相同步骤添加其它服务器。
4. 服务器列表中的 `↗`、`✎`、`×` 分别用于打开后台、修改配置和删除配置。
5. 勾选“启用自动同步”，保存后点击“立即同步”。

### Chrome

1. 打开 `chrome://extensions`，启用“开发者模式”。
2. 点击“加载已解压的扩展程序”，选择 `tools/auto-sync-sns-cookies/chrome`。
3. 添加服务器时，按浏览器提示授予该 Drop2Tunnel Origin 的访问权限。

### Firefox Windows

临时调试：

1. 打开 `about:debugging#/runtime/this-firefox`。
2. 点击“临时载入附加组件”，选择 `tools/auto-sync-sns-cookies/firefox-windows/manifest.json`。
3. 临时扩展会在 Firefox 退出后移除；长期使用应将该目录打包并通过 Mozilla AMO 以“不公开列出”方式签名，再安装签名后的 XPI。

### Firefox Android

Android 版本使用 Manifest V2 事件页，避免依赖 Firefox Android 尚未支持的扩展后台 Service Worker。添加服务器时，它会按该 Drop2Tunnel Origin 动态申请访问权限；业务代码只读取上方列出的 SNS 域名 Cookie。

临时调试需要电脑安装 ADB 和最新版 `web-ext`，手机开启 Firefox 的“通过 USB 远程调试”，然后执行：

```bash
web-ext run --target=firefox-android --source-dir tools/auto-sync-sns-cookies/firefox-android --android-device <设备ID> --firefox-apk org.mozilla.firefox
```

长期安装需要先通过 Mozilla AMO 签名 XPI。把签名后的 XPI 放到手机后，在 Firefox“关于 Firefox”页连续点击 Firefox Logo 五次，随后从设置中的“从文件安装扩展”选择该 XPI。

## 配置备份

- 点击“导出配置”会在插件面板中显示 Base64，并可点击“复制”保存。
- 备份包含全部服务器地址、同步密钥、启用状态和同步间隔，不包含 SNS Cookie 或同步结果。
- 将 Base64 粘贴回同一输入框并点击“导入配置”，会整体替换当前服务器列表，并一次申请所有服务器的访问权限。
- Base64 只是编码而非加密，必须按同步密钥同等级别保管。

## 自动触发

- 默认每 15 分钟检查一次；Cookie 内容没有变化且刚同步过时不会重复上传。
- 任一受支持平台的 Cookie 发生变化后延迟约 1 分钟同步，避免页面加载期间反复写入。
- 任一受支持 SNS 页面很久未打开后再次打开，会在页面稳定几秒后同步。
- 平台没有 Cookie 或无法识别登录态时会跳过该平台；服务端只写入本次批量请求中经过校验的平台。

## 安全边界

- 扩展只读取上方列出的 SNS 域名 Cookie，不读取其它网站 Cookie，也不会把 Cookie 写入日志。
- 每台服务器使用自己的同步密钥。密钥保存在当前浏览器的扩展本地存储中；对应服务端只保存其 SHA-256 哈希。
- 从扩展删除服务器会停止向它同步并撤销扩展的 Origin 访问权限，但不会替你撤销服务端密钥；应在该服务器的 `/sns-cookies` 单独撤销。
- 可随时在 `/sns-cookies` 撤销或重新生成密钥。重新生成后，扩展内该服务器的旧密钥会立即失效，需要使用 `✎` 更新。
- 同步密钥是管理页生成的 43 位 ASCII 字符串。扩展可从带少量说明文字的粘贴内容中提取唯一密钥；无法唯一识别时会要求重新复制，不会把异常字符写入请求头。
- 建议为 yt-dlp 使用独立的 YouTube 账号。YouTube 可能按浏览器会话、IP 和反自动化策略轮换或拒绝 Cookie，自动同步只能减少手工导出，不能保证账号 Cookie 永久有效。
