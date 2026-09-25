# 多语言、本地化运行时与 i18n 审计

> **源码基线 Commit**：`b422e438fe50f78fdacd84ac1dff34a30a3d43ba`  
> **文档更新时间**：`2026-09-26`

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
- `fa` — فارسی
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
   - RTL 的 fa
   - 长文本语言。

## 12. RTL 与布局

`fa` 是 RTL 语言。

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
