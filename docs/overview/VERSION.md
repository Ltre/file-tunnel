# docs/overview 文档基线与维护规则

## 当前全局源码锚点

- 当前已完整覆盖的源码 Commit：`b422e438fe50f78fdacd84ac1dff34a30a3d43ba`
- 源码锚点提交时间：`2026-09-25T02:07:27Z`
- 源码锚点提交说明：`先固定代码：feat: 接通下载任务转码、网页 ZIP 资源导入与网盘拖放上传`
- 文档体系首次建立日期：`2026-09-26`
- 文档更新时间：`2026-09-26`
- 当前状态：**首轮模块总览、源码对照与历史锚点已经建立；后续从该 Commit 开始做增量维护。**

> 本文件故意不记录“源码基于哪个开发分支”。分支会持续切换和合并，不适合作为长期事实锚点；Git Commit 才是可复现的版本定位。

## 后续 Agent 必须遵循的扫描规则

### 1. 只以 `dev/doc-overview` 中已经合入的项目内容为准

用户会把其它开发分支中需要沉淀的成果持续合并到 `dev/doc-overview`。

因此后续更新 Overview 时：

- 不需要追踪其它开发分支当前发展到哪里；
- 不要在模块文档中写“基于某开发分支”；
- 不要因为知道其它分支存在某项功能，就提前把它写成当前实现；
- 除非用户明确要求研究某个其它分支，否则以 `dev/doc-overview` 已合入内容为唯一增量扫描来源。

这里提到 `dev/doc-overview` 是**维护工作树规则**，不是模块文档的“源码分支版本号”。

### 2. 增量扫描必须排除 `docs/overview/**`

`docs/overview` 是整理产物本身，不能拿它反过来判断项目又新增了哪些功能。

后续 Agent 应关注 `dev/doc-overview` 中除 `docs/overview/**` 外的变化，包括：

- 源码；
- `tests/**`；
- `prompts/dev-prompt-logs/**`；
- `prompts/ideas/**`；
- `docs/devlog/**`；
- 其它 Guide / 配置 / 部署资料；
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

### 4. 何时推进全局源码锚点

如果 `dev/doc-overview` 在当前锚点之后只有 `docs/overview/**` 的文档提交，则**不要**推进源码锚点。

只有当：

1. 新的非 `docs/overview` 项目变化已经合入 `dev/doc-overview`；
2. 已扫描相关源码、Git Log、Prompt、Devlog、Tests；
3. 受影响 Overview 文档已经同步更新；

才把本文件的“当前已完整覆盖的源码 Commit”推进到能够代表这批新项目事实的 Commit。

### 5. 不要把未合入需求写成当前实现

如果某个需求：

- 只存在于其它开发分支；
- 只存在于当前对话但尚未合入代码；
- 只存在于 Idea/设计稿而没有进入当前实现；

则必须继续标为“计划 / 待实现 / 待核实”，不能因为 Agent 知道它存在就写成当前功能。

## 增量扫描清单

每次更新至少检查：

- 基线之后新增、修改、删除的非 `docs/overview` 源码；
- 新增或变化的 API / Socket event；
- Service Worker / IndexedDB / DB schema / 配置版本；
- `prompts/dev-prompt-logs` 中的新需求、人工复测和验收结果；
- `docs/devlog` 中的新根因、实现过程和验证边界；
- `prompts/ideas` 中从 Idea 进入实施阶段的设计；
- 新增 regression tests；
- Git Log 中的稳定点、回退点、`DEBUG`、`WRONGCODE`、`有BUG`、`待测`；
- 旧需求被后续需求覆盖、废弃或收敛后的最终行为。

## 信息解释规则

- **源码**代表当前实现事实。
- **Prompt**最适合恢复需求原意和人工验收。
- **Devlog**最适合恢复实现原因、根因和验证边界。
- **Git Log**用于定位演进顺序、稳定点和错误版本。
- **Tests**用于固定回归，但不能自动替代真实浏览器、Telegram、yt-dlp、FFmpeg、WebRTC 等环境验收。
- 如果来源冲突，应写清“历史要求 → 中间实现 → 当前行为”，不要把冲突强行揉成一个结论。
- 用户后续真实复测可以推翻此前 Agent 的“已完成”自述。
