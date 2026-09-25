# docs/overview 文档基线

## 当前全局源码锚点

- 文档维护分支：`dev/doc-overview`
- 首轮源码基线分支：`dev/2609-s1`
- 首轮源码基线 Commit：`b422e438fe50f78fdacd84ac1dff34a30a3d43ba`
- 源码基线提交时间：`2026-09-25T02:07:27Z`
- 文档首轮整理日期：`2026-09-26`
- 源码基线提交说明：`先固定代码：feat: 接通下载任务转码、网页 ZIP 资源导入与网盘拖放上传`
- 首轮状态：**模块总览、源码对照、历史锚点已经建立；后续按此 Commit 做增量维护。**

## 首轮文档提交链

本轮采用分阶段提交，避免长任务中断丢失：

1. `c4001469bf1fa8ba01f44c230a5b0c1e04472012` — 建立 `master.md` 与版本锚点。
2. `24fe711db73a0ee1ca5770594b043e03666e71b7` — 架构、隧道、传输/缓存。
3. `ad19e08bf3cbf31e93631e88d2985d91bd9efb6a` — Telegram Bot/内容管理与虚拟网盘。
4. `737ad015e96ab1ab488427ab55ecb5a6fa6f4644` — 网页工坊、SNS/YouTube/音轨/转码。
5. `7ed71f6c6366dfb8e4eb16226ba1cf338601e137` — 媒体/实时通信、PWA/UI。
6. `90fb3444f3deab27a89a1434a7023a9e0a894a4e` — 管理/安全/部署、VClient、测试回归。
7. `1bb1e133421e57bea823d0dc105c25ee38a6a083` — 源码映射与开发时间线。

当前文件所在提交会继续补 Light Transfer、总入口和本版本说明。

## 用途

本文件是 `docs/overview` 文档体系的**源码增量锚点**，而不是要求未来对“文档分支自己的最后 Commit”做 diff。

以后用户把新开发代码合并到 `dev/doc-overview` 后：

1. 读取这里的源码基线 Commit；
2. 确定新合入代码对应的最新源码 Commit；
3. 对比这两个源码版本；
4. 同时扫描期间新增的 Git Log、Prompt、Devlog、Tests；
5. 更新受影响模块；
6. 把“当前全局源码锚点”推进到已经完整覆盖的新源码 Commit。

这样无需每次从项目创建初期重新扫描。

## 增量扫描清单

每次更新至少检查：

- 基线之后新增/修改/删除的源码；
- `prompts/dev-prompt-logs` 新需求与人工复测；
- `docs/devlog` 新开发记录；
- `prompts/ideas` 中从 Idea 进入实现的设计；
- Git Log；
- 新 regression tests；
- Service Worker/DB schema version；
- API/Socket event 改动；
- 旧需求被覆盖/废弃的情况。

## 信息解释规则

- **源码**代表当前实现事实。
- **Prompt**最适合恢复需求原意和人工验收。
- **Devlog**最适合恢复实现原因、根因和验证边界。
- **Git Log**用于定位时间、稳定/错误版本和演进顺序。
- **Tests**用于固定回归，但不能自动替代真实浏览器/Telegram/yt-dlp/WebRTC 验收。
- 如果来源冲突，必须写清“历史要求 → 中间实现 → 当前行为”，不要强行揉成一个结论。
- 人工验收优先级高于没有后续实测支撑的 Codex “已完成”自述。

## 当前基线之外的已知后续需求

在首轮源码锚点之后，用户又提出过新需求，例如：

- Android 平板宽屏三栏高度/空白；
- transcode output extension 新规则；
- Web ZIP `manifest.json` 与全屏浮层运行；
- 网页工坊媒体拖放插入 HTML；
- 网盘文件/目录协同编辑及邀请链接。

这些需求**尚不能因为出现在对话里就写成当前 `dev/2609-s1@b422e...` 已实现功能**。

当其代码合入 `dev/doc-overview` 后，应在下一轮增量更新时转入相应模块的“当前实现”章节。
