# 开发演进时间线索引

本目录不是 Git Log 的复制，而是用于解释“为什么当前代码存在这些特殊分支/兼容逻辑”。

整个初始 Overview 的历史覆盖从仓库第一个 Commit 开始：

`192ecbcb9ea27a9754f8622041165f9712a8fbf4` — 2026-06-21 — `Initial commit`

第一个实际代码版本：

`0224de3d07f2160055eef58dd1907235aed3aef4` — 2026-06-21 — `最初版本`

时间线：

- [2026-06-07.md](./2026-06-07.md)：项目起源、最初架构、协同编辑、P2P/Relay、磁链、设备 Profile/直接隧道、合辑、播放器、文件句柄、资源管理器、富文本权限。
- [2026-08.md](./2026-08.md)：YouTube Premium、Light Transfer、持久审计、VClient、远程预览、SNS、Telegram 网盘起点。
- [2026-09.md](./2026-09.md)：Telegram 网盘成熟、SQLite 设计、网页工坊、转码、Telegram 内容管理以及 260924 验收。

维护时请同时看：

- 当前模块文档；
- `source-map.md`；
- `COVERAGE.md`；
- 实际 Git commits；
- Devlog；
- Prompt 的最终人工复测。
