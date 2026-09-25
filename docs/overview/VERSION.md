# docs/overview 文档基线与维护规则

## 初始创建阶段状态

**状态：已完成并冻结。**

初始 Overview 已完成从项目创建起点到当前应用源码锚点的历史与现状整理，并完成当前页面、客户端模块、服务端模块、工具链的文件级覆盖验收。

### 历史覆盖起点

- 仓库第一个 Commit：`192ecbcb9ea27a9754f8622041165f9712a8fbf4`
- 时间：`2026-06-21`
- Commit message：`Initial commit`

### 第一个实际代码版本

- Commit：`0224de3d07f2160055eef58dd1907235aed3aef4`
- 时间：`2026-06-21T01:39:44Z`
- Commit message：`最初版本`

### 当前已完整覆盖的应用源码锚点

- Commit：`b422e438fe50f78fdacd84ac1dff34a30a3d43ba`
- 时间：`2026-09-25T02:07:27Z`
- Commit message：`feat: 接通下载任务转码、网页 ZIP 资源导入与网盘拖放上传`

### 初始 Overview 内容冻结 Commit

- Commit：`97e37c61674efd7cb1f92a34b8ef845f04dd4e18`
- Commit message：`docs: complete overview cross-links and early project history`
- 冻结日期：`2026-09-26`

该 Commit 是本轮初始创建阶段最后一个**实质性文档内容整理 Commit**。其后的 `docs: freeze initial overview baseline` 仅用于写入本文件和覆盖验收状态，属于版本标记，不改变业务说明内容。

## 为什么源码锚点不是 dev/doc-overview 当前 HEAD

从 `b422e438fe50f78fdacd84ac1dff34a30a3d43ba` 到冻结前的 `dev/doc-overview`，已经通过 Git compare 核实：

- 分支只向前增加 Overview 文档提交；
- 所有变更文件都位于 `docs/overview/**`；
- 没有新的应用源码、Tests、Prompt、Devlog、配置或其它项目资料变化。

因此，初始阶段的当前产品事实终点仍然是 `b422e438fe50f78fdacd84ac1dff34a30a3d43ba`。

后续用户开始向 `dev/doc-overview` 合并新的开发成果后，才需要从这个源码锚点继续增量扫描。

## 文档时间

- 文档体系首次建立日期：`2026-09-26`
- 初始创建阶段冻结日期：`2026-09-26`
- 本文件更新时间：`2026-09-26`

## 后续 Agent 必须遵循的扫描规则

### 1. 只以 dev/doc-overview 中已经合入的项目内容为准

用户会把其它开发分支中需要沉淀的成果持续合并到 `dev/doc-overview`。

因此后续更新 Overview 时：

- 不需要追踪其它开发分支当前发展到哪里；
- 不要在模块文档中写“基于某开发分支”；
- 不要因为知道其它分支存在某项功能，就提前把它写成当前实现；
- 除非用户明确要求研究某个其它分支，否则以 `dev/doc-overview` 已合入内容为唯一增量扫描来源。

这里提到 `dev/doc-overview` 是**维护工作树规则**，不是模块文档的“源码分支版本号”。

### 2. 增量扫描必须排除 docs/overview/**

`docs/overview` 是整理产物本身，不能拿它反过来判断项目又新增了哪些功能。

后续 Agent 应关注 `dev/doc-overview` 中除 `docs/overview/**` 外的变化，包括：

- 源码；
- `tests/**`；
- `prompts/dev-prompt-logs/**`；
- `prompts/ideas/**`；
- `docs/devlog/**`；
- 其它 Guide / Adapter / 配置 / 部署资料；
- Git Log 和相关提交差异。

概念上，增量比较应等价于：

```text
上次已覆盖的源码锚点 Commit
        ↓
当前 dev/doc-overview
        ↓
排除 docs/overview/**
        ↓
识别真正新增/变化的项目事实
        ↓
只更新受影响的 Overview 文档
```

### 3. Commit 与文档更新时间必须同时维护

模块文档如果记录版本信息，统一使用：

```md
> **源码基线 Commit**：`<commit sha>`
> **文档更新时间**：`YYYY-MM-DD`
```

两者含义不同：

- **源码基线 Commit**：本文所描述的当前实现事实已经核对到哪个不可变 Git 版本；
- **文档更新时间**：该 Markdown 最近一次实际整理/复核日期。

不要再增加“源码分支”“基于分支”“当前开发分支”等头部字段。

### 4. 后续从哪里开始扫描

初始冻结后，下一轮更新默认从：

`b422e438fe50f78fdacd84ac1dff34a30a3d43ba`

开始。

但比较目标是当时 `dev/doc-overview` 的最新内容，并且**过滤掉 `docs/overview/**`**。

如果过滤后没有新变化：

- 不更新业务文档；
- 不推进源码锚点。

如果存在新变化：

1. 阅读 diff / 新源码；
2. 阅读期间新增 Git Log；
3. 阅读相关 Prompt / Devlog / Idea / Tests；
4. 更新受影响模块；
5. 做当前文件级覆盖复核；
6. 把“当前已完整覆盖的应用源码锚点”推进到已经完整整理的新 Commit。

### 5. 不要把未合入需求写成当前实现

如果某个需求：

- 只存在于其它开发分支；
- 只存在于当前对话但尚未合入代码；
- 只存在于 Idea/未来计划而没有进入当前实现；

则必须继续标为“计划 / 待实现 / 待核实”。

例如当前源码锚点之后出现过：

- Android 平板宽屏三栏高度/空白；
- transcode output extension 新规则；
- Web ZIP `manifest.json` 与全屏浮层；
- 网页工坊媒体拖入编辑器；
- 网盘目录/文件协同编辑与邀请链接；
- `dev-2610.md` 中的 Markdown、标签索引、视频随机取帧、网易云、Linux CLI、NFC、中继网等未来方向。

只有相应成果真正合入 `dev/doc-overview` 的非 Overview 路径，才能在后续更新中转为当前实现。

## 信息解释规则

- **源码**代表当前实现事实；
- **Prompt**用于恢复需求原意和人工验收；
- **Devlog**用于恢复根因、实现过程和验证边界；
- **Git Log**用于定位演进顺序、稳定点、回退点和错误版本；
- **Tests**用于固定回归，但不能自动替代真实浏览器、Telegram、yt-dlp、FFmpeg、WebRTC 等环境验收；
- 如果来源冲突，写清“历史要求 → 中间实现 → 当前行为”；
- 用户后续真实复测可以推翻此前 Agent/Codex 的“已完成”自述。

## 初始覆盖验收

详细文件级验收见：

[COVERAGE.md](./COVERAGE.md)

后续更新时可以复用该文件的“页面 / client / server / tools 归属”检查方式，避免项目新增模块后 Overview 长期漏记。
