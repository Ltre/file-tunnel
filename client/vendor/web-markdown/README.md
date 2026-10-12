# ZIP 内置 Markdown 支持资源

这些固定版本资源只在网页工坊点击 `+ Markdown` 时读取，并随 ZIP 打包，不依赖运行时 CDN。部署构建保留本目录路径，Service Worker 缓存这些文件以支持离线创建。

- Marked 18.0.14，来自官方 npm `marked@18.0.14` 的 `lib/marked.umd.js`；[官方源码及版本](https://github.com/markedjs/marked/tree/v18.0.14)，MIT。
- DOMPurify 3.4.16，来自官方 npm `dompurify@3.4.16` 的 `dist/purify.min.js`；[官方源码及版本](https://github.com/cure53/DOMPurify/tree/3.4.16)，Apache-2.0 或 MPL-2.0。
- `markdown-page.js` 和 `markdown-page.css` 为本项目生成页面的加载、路径解析及基础样式。

第三方版权及完整许可证保留在 `THIRD-PARTY-LICENSES.txt`，该文件也随 ZIP 打包。升级资源时需同步更新 `client/web-workshop.js` 中版本及 SHA-256，并核查包内资源、生成页面、部署和离线测试。
