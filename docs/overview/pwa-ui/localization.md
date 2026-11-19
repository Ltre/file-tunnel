# 多语言、本地化运行时与 i18n 审计

> **源码基线 Commit**：`1da33930cfb0f7022114825e2cb300ce18ff4eae`  
> **文档更新时间**： 2026-11-19

## 1. 模块定位

Drop2Tunnel 的多语言并不是浏览器自动翻译，而是项目自身维护语言选择、词条表、运行时 DOM 本地化和服务端 Telegram 文案翻译。

主要实现：

- `client/i18n.js`
- `client/i18n-catalog.js`
- `client/localization-runtime.js`
- `server/i18n.js`
- `tools/i18n-audit.js`
- `tools/server-i18n-audit.js`

历史上曾出现翻译体系被错误批量替换而严重错乱，因此后续改词条必须保留可审计性。

## 2. 当前语言

客户端当前 `SUPPORTED_LANGUAGES` 有 16 种：

- `zh-Hans` — 中文简体
- `zh-Hant` — 中文繁體
- `en` — English
- `ja` — 日本語
- `fr` — Français
- `ru` — Русский
- `es` — Español
- `it` — Italiano
- `de` — Deutsch
- `ko` — 한국어
- `ms` — Bahasa Melayu
- `id` — Bahasa Indonesia
- `vi` — Tiếng Việt
- `km` — ភាសាខ្មែរ
- `my` — မြန်မာဘာသာ
- `th` — ไทย

默认：

`zh-Hans`

localStorage key：

`drop2tunnel.language`

## 3. 客户端职责拆分

### `client/i18n-catalog.js`

主要词条 catalog。

### `client/i18n.js`

负责：

- supported language list；
- 当前语言；
- localStorage；
- 翻译函数；
- 部分 UI 动态词条；
- 语言切换。

### `client/localization-runtime.js`

用于对动态 DOM / 页面运行时内容进行本地化处理。

因此新增动态组件不能只改静态 HTML 文本后认为完成国际化。

## 4. 服务端 i18n

`server/i18n.js` 当前重点覆盖 Telegram Bot 回复和若干服务端动态错误/状态。

Telegram 用户可能完全不打开 Web 页面，所以服务端必须能够独立按用户/语言生成：

- tunnel relay 文案；
- 错误；
- 文件大小限制；
- 已发送到某隧道；
- media collection；
- command 描述等。

服务端语言集合与客户端目标基本一致。

## 5. 为什么不能依赖 Google Translate

页面设置：

`translate="no"`

并常带：

`google notranslate`

设计目标是：

- UI 术语一致；
- 技术名词不被随意改；
- 中文原始需求可映射到稳定 key；
- Telegram/server 文案也能一致。

浏览器自动翻译不是项目 i18n 的替代品。

## 6. 语言选择入口

界面语言属于隧道/工具设置中的用户 UI 偏好。

它是浏览器本地偏好，不等同于：

- tunnel metadata；
- account locale；
- Telegram language_code。

因此同一个隧道内不同设备可以使用不同界面语言。

## 7. 动态内容

以下内容不能简单全文翻译：

- 用户文件名；
- 用户 remark；
- 富文本；
- Telegram caption；
- device name；
- path；
- shell/log 原文。

翻译层应只处理系统 UI/系统错误。

## 8. Exact Text 与参数化文本

服务端有两类：

### Exact text

按完整中文 source string 查表。

### 参数化文案

例如：

- 当前处于 XXXXX 隧道中转模式；
- Telegram Bot 文件限制；
- 已发送到隧道 XXXXX；
- 合辑文件数。

这些通过 regexp 抽参数，再为每种语言生成。

修改源文案时必须检查参数化 regexp，否则可能让翻译静默失效。

## 9. Audit 工具

- `tools/i18n-audit.js`
- `tools/server-i18n-audit.js`

用途是发现：

- UI 新增中文但未入 catalog；
- key 缺翻译；
- 服务端可见字符串未覆盖；
- 词条数量/语言结构异常。

新增大批 UI 后应跑审计，而不是等用户切语言才发现半页中文。

## 10. 历史回归

2026-08-12 左右项目重新补齐 16 语言体系。

Git 历史里有过翻译错误回退，因此一个重要原则是：

> 不要用“机械全局替换”把现有中文字符串批量转换成另一个语言字符串，再反推 key。

原始中文通常承担 source key 角色，错误替换会破坏 lookup。

## 11. 新功能接入规则

新增用户可见功能时：

1. 判断是否属于普通用户界面还是仅管理员内部页；
2. 新系统文案进入 catalog；
3. 动态模板保留参数；
4. 更新运行时；
5. 如果 Telegram/server 也会输出，更新 server i18n；
6. 跑 audit；
7. 至少抽查：
   - zh-Hans
   - en
   - ja
   - `de`（德语长词/布局）
   - 长文本语言。

## 12. RTL 与布局

当前 16 语言中已不包含 RTL 语言：旧 `fa`（波斯语）包已移除，由 `de`（德语）替代。若未来重新加入 RTL 语言，仍需按方向性规则处理，而不能把所有容器全局反转。

国际化不仅是字符串替换，还要注意：

- flex direction；
- icon + text；
- margin-left/right；
- path/code 仍应 LTR；
- 数字和技术 token；
- 弹窗宽度。

不要为修某个 RTL 页面直接全局反转所有业务容器。

## 13. 与模块文档的关系

各模块文档描述业务原始中文术语；本文件描述语言实现。

后续 Agent 不应为了“Overview 统一英文”把需求里的按钮原名改掉。原始中文 UI 名称往往正是追查 Prompt / DOM / Git Log 的检索锚点。

## 14. 2026-11-07—10：唯一词条源、按需语言包与系统语言确认

### 14.1 目录和运行时拆分

`client/i18n-catalog.js` 仍是唯一人工维护的词条、动态模板和规则来源。发布不再把完整目录直接作为首屏脚本：

- `tools/build-i18n-packs.cjs` 从唯一目录生成 `client/i18n-bootstrap.js` 和 `client/i18n/{language}.json`。启动包只包含简体中文、繁体中文、英文基础词条及运行配置；其余 13 种语言按需取包。完整目录约 2.08 MB，启动包约 305 KB。
- 当前支持 16 种语言。其余语言包以目录源码 SHA-256 的前 16 位作为版本，客户端校验语言、版本、词条键集合、模板数量及字符串类型；请求按语言去重，额外语言包最多在本机 localStorage 缓存一份当前版本。下载有 15 秒超时，缓存损坏或版本不符时重新获取，失败不改变已保存语言偏好。
- 生成目录会包含 `zh-Hant.json` 供构建一致性检查；正常繁体中文启动已在基础包中，首屏不额外请求该文件。
- `client/localization-runtime.js` 现在只是兼容加载器，最终只加载 `client/i18n.js`；`client/sns-post-i18n.js` 和 `client/streaming-i18n.js` 不再维护各自的翻译字典，相关新词由中央目录维护。

### 14.2 系统语言不是按服务器地区推断

- 语言偏好默认是 `system`。简体中文、繁体中文、英文可由启动包直接呈现；若浏览器系统语言是其它支持语言，首屏先用英文，不在页面初始化时自动下载。
- 页面整体加载完成后，用户**主动打开隧道设置**时才提示是否下载检测到的系统语言包。确认且下载、校验成功后才切换；取消不下载。明确选择的语言优先于系统语言，系统语言确认状态与偏好跨同源页面同步。
- 语言判断来自浏览器 `navigator.language` / `navigator.languages`，不是 IP、服务器地区或账户地区。浏览器后续触发 `languagechange` 时，只有仍选择“使用系统语言”才重新处理。
- 异步下载完成只刷新仍然有效的当前语言；失败发出专用事件并可重试，不以迟到响应覆盖用户后来选择的语言。localStorage 写入失败时，本页仍可使用暂存偏好。

### 14.3 构建、缓存和原文边界

- `tools/deploy/build.mjs` 在构建前执行语言包一致性检查，打包 bootstrap 与 `client/i18n/` JSON；修改目录后先运行 `node tools/build-i18n-packs.cjs` 重新生成。构建会对服务端动态生成的 Telegram OIDC 回调 HTML 中的脚本引用执行与静态页面相同的资产指纹替换。
- 页面与独立入口（分享、协同、网页 ZIP 预览、磁链/光媒页及 Telegram OIDC 回调）统一使用启动包和同一运行时，不再重复加载完整目录。Service Worker 当前资源版本为 `instant-tunnel-v151-content-v8-261119-1`；激活时只清理旧的 `instant-tunnel-*` 缓存，不删除其它应用的 CacheStorage，也不清理业务 IndexedDB。
- 动态文案只翻译已识别的系统模板及命名标签，不翻译用户正文、文件名、路径、分区名、消息内容和富文本编辑区域。参数值、错误码及文件路径保留原文。动态 DOM 使用 WeakMap 保存原文与空白，避免 MutationObserver 反复翻译后空格累积。
- `tools/frontend-i18n-audit.js` 提供前端词条审计，默认只读；`--rewrite-dialogs` 才执行原生 `alert/confirm/prompt` 包装改写。最终目录覆盖 15 个目标翻译语言，构建检查生成文件与唯一源目录一致。审计候选和自动提取结果不是“所有运行时文案都可自动翻译”的承诺。

关联回归：`tests/frontend-i18n-audit-261108.test.cjs`、`i18n-catalog-261108.test.cjs`、`i18n-261108.browser.cjs`、`i18n-261109.browser.cjs`、`i18n-lazy-261109-2.browser.cjs`、`i18n-packs-261109.test.cjs`、`public-drive-i18n-261109.browser.cjs`、`streaming-i18n-261109.browser.cjs`、`sw-language-update-261109.browser.cjs`。


## 15. 2026-11-18—19：德语包与网页工坊草稿文案

- 当前 16 种语言中，`de`（Deutsch）替代旧 `fa`（فارسی）；`client/i18n/de.json` 新增，`client/i18n/fa.json` 删除。总语言数不变，启动包仍包含简中/繁中/英文，其余 13 种语言按需加载。
- 新增并补齐网页工坊草稿入口“转入草稿箱编辑”等文案，以及“原记录”“发布”“来源隧道:{0}”“{0} 个文件”等动态模板；参数占位符保持原样。相关词条由中央目录生成，不在网页工坊或串流模块内另建词条表。
- `de` 不是 RTL 语言；当前语言集不再有波斯语方向测试项。布局审查改为检查德语长词、长文本和常见窄屏折行，同时保留未来 RTL 兼容规则。
- Service Worker 资源版本为 `instant-tunnel-v151-content-v8-261119-1`；`content-v8` 业务缓存语义未变，按需语言包继续走版本校验与缓存更新。

专项回归：`tests/control-center-drag-261118.browser.cjs`、`tests/requirements-261119.browser.cjs`、`tests/i18n-packs-261109.test.cjs`、`tests/sw-language-update-261109.browser.cjs`。
