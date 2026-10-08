# Drop2Tunnel 网盘分区管理与协同项目挂载：开发实施指南

> **文档用途**：交给 Codex 的需求约束与实施前置指南。本文属于「经过讨论确认的产品需求 + 基于特定 Git 版本的代码审查 + 建议实施方案」，**不是要求逐行照抄的代码改动清单**。
>
> **唯一目标分支**：`dev/2609-s6-disk-shared-content-object`。
>
> **本次代码调查基线**：`b4bedfdca3f36e999fc0c63263f9f08784cfdf75`（2026-10-08 读取 GitHub 远程分支 HEAD）。此前讨论所基于的 `be4424b3962ca4fe461f28e924ffb7ae7742fd60` **已经过时**。
>
> **需求依据**：用户提供的完整讨论记录《粘贴的文本 (1)(9).txt》，尤其是用户明确接受的八项决定、嵌套污染补充约定，以及其后确认的 Partition Identity / CollaborationMount / Namespace Resolver / Mutation-Scope Invariant 四层定义。
>
> **交给 Codex 前的硬性要求**：Codex 应先核对本地工作区当前分支、实际 HEAD、未提交改动、数据库 schema、源码、测试和近期提交；**本地新代码比本文调查基线更新时，以本地实际代码为技术事实源**。但不能以“代码已有不同实现”为理由擅自推翻本文标记为 **产品硬约束** 的需求。需要调整技术路径时，在开发记录中交代偏差、理由、兼容性和测试。如果发现产品硬约束与现状存在无法安全消解的冲突，应先记录并请求用户决策，**不可暗中弱化安全边界**。
>
> **任务界限**：本次仅形成开发指南，未修改任何 Git 分支或仓库业务代码。后续 Codex 是否实际修改、暂存、提交或 push，须服从用户给 Codex 的下一轮明确指令；不要从本文档推断已经授权执行 Git 写操作。

---

## 1. 目标、边界与验收概览

本次有两个用户可见主功能：

**A. 个人网盘设置与分区管理**：网盘顶部刷新按钮紧邻左边增加齿轮按钮；设置界面区分个人网盘全局设置与当前分区设置；支持分区显示名称修改、普通分区删除、分区复刻，并整合已有的新建分区和 S3 配置。默认分区不可删除。

**B. 协同项目挂载**：用户可以将自己已获授权、由他人创建的整个协同项目作为一个**特殊节点**放到自己任何层级的**原生目录**中；分区根目录只是原生目录的一种，统一称为 **「挂载到我的网盘」**。挂载仅是入口/指针，不复制远端目录、文件和 Content Object，也不改变协同发起者的数据归属。

最重要的系统原则：

```text
用户本人 Native Namespace
  ├── native directory
  ├── logical file ──→ shared Content Object ──→ Telegram physical
  └── collaboration_mount   [特殊叶节点，不是目录，也不是普通 logical file]
          └── collaborationId ──→ 当前 Grant ──→ 远端 Owner Namespace
```

**验收定义**：新增功能不能突破权限和作用域；不能让本地目录递归操作误删远端协同内容；不能把协同项目嵌套成循环；不能因为分区改显示名称而改变底层数据位置；不能因为复刻分区而重复 Telegram 正文；不能破坏 S6 现有原生跨分区复制/移动、静态资源、S3、Content Object 生命周期与旧协同页。

---

## 2. 最新 S6 代码现状：哪些已经具备、哪些尚缺

以下结论仅针对上述 `b4bedfd…` 版本。**不要把旧的概览文档当成更新事实**：例如 `docs/overview/telegram-drive.md` 当前仍有基于 2026-09-26、JSON 持久化阶段的说明，与源码已经实现的 SQLite/Content Object 不一致。Codex 应以源码和测试为准，并在实施时纠正文档漂移。

| 当前真实能力 / 缺口 | 代码位置与注意事项 |
|---|---|
| 分区当前仍以 `diskSpace` 字符串为主要身份 | `server/disk-api.js::createDiskSpaces()`；全局 `spaces` / `space_usage`；`forUser()` 同时考虑 usage 与实际文件/目录；`get(value)` 有隐式创建分区 Store/登记功能。`GET /spaces` 返回 `{id:name, name:name}`，目前 `id` 并非独立永久身份。 |
| 个人分区是“用户 + scope”组成的逻辑归属 | 原始 `disk_spaces` 名称集合并不代表某用户独占这个全局字符串。**不能把用户删除分区误写成删除所有用户共用的 `diskSpace` 字符串或物理 Store。** |
| 原生跨分区复制及移动**已经存在** | `POST /spaces/transfer` 支持 `copy`/`move`，利用共享 Content Object reference、lease 与 SQLite `persistence.atomic()`；`client/disk-ui.js::transferTelegramDriveItemsAcrossSpaces()`、`client/disk-copy-picker.js`。**绝不能因本次“跨 Mount 禁止 Move”误取消同一用户两个 Native 分区之间已有的 Move 能力。** |
| 静态资源已升级 | `server/disk-static-resources.js` 支持独立配置、保护、缓存时长等；`disk-api.js` 中 `/static-resources` 与目录/文件写保护；`client/disk-ui.js` 已有“已开放静态资源”。Mount 必须不进入静态资源递归暴露。 |
| 协同现为文件级/目录级 Grant | `server/disk-collaboration.js` 中 `kind=file|directory`、`ownerId/diskSpace/path/fileId/members[]/invites/memberVersions`；`authorized()` 目前校验成员/所有者，**没有真正 viewer/editor 角色鉴权**。`relocateDirectory/relocateFile()` 可随目录操作调整目标。 |
| 协同已有单独界面和受限 API | `client/disk-collaboration.js` 与 `browser.use('/collaboration-scope/:collaborationId', ...)`；服务器已拦截若干越界 path/file 操作，并将真正 Store 切换为 owner scope。新增 Mount 应尽可能复用、加强，不要平行复制一套脆弱路由。 |
| Native 文件/目录仍以路径表达层级 | `server/telegram-drive.js` 的 `getDirectoryTree()/moveDirectory()/removeDirectory()/assertFreeName()`；目录移动按路径前缀重写。新增 Mount 需处理父目录移动后的挂载路径一致性，不能留下孤儿。 |
| 当前全局搜索只面向所在 Store | `GET /search` 调用 `store.search(owner,q,500)`；`client/disk-ui.js` 的 `telegramDriveSearchAll` 是“所有文件”选项。新增“附加已挂载的协同内容”要增加独立搜索来源和结果 origin，而非将他人文件插进本人索引。 |
| S6 已有共享 Content Object | `server/disk-content-repository.js` 的 `disk_content_refs`、leases、cleanup 等；下载/repair/reuse 等已使用共享内容身份。分区复刻、授权 Copy 应依靠 Logical reference，不重发 Telegram 消息。 |
| UI 已有分区/S3管理入口 | `client/disk-ui.js::manageTelegramDriveSpaces()`，当前账号区仍有“管理分区 / S3”；头部刷新按钮 `telegramDriveRefreshBtn`；不能新建一套孤立设置而让旧入口功能丢失。 |
| 统一 SQLite 原子边界已存在 | `server/disk-repository.js::atomic()`：同步事务、拒绝异步 Promise；支持 WAL、`foreign_key_check`。新 topology 校验与写入应尽量在同一原子边界内；绝不能将网络/Telegram 调用留在 SQLite 长事务内。 |
| 本次要求的 Partition 实体和 Mount 实体**尚未实现** | 当前代码并无已核实的稳定 per-user `partitionId + displayName` 模型，也没有 `collaboration_mount` node、Mount 关系表或统一 namespace resolver。应新增或等价改造，而非声称旧代码已经具备。 |

**关键兼容性修正**：讨论里曾泛称“跨 namespace 一律 Copy”。在最终实施中需精确区分：**Native 分区 A → 同一用户 Native 分区 B** 可继续保持已有的显式 Copy/Move；**Native ↔ Foreign Collaboration、Foreign A ↔ Foreign B** 仅允许 Copy，禁止跨协同授权边界 Move。两者不是同一约束。

---

## 3. 需求分层：不能误解的产品硬约束 / 允许 Codex 变通的部分

### 3.1 产品硬约束（不可自行改变）

1. 齿轮位于**网盘顶部刷新按钮紧邻左侧**，提供个人网盘全局设置和当前分区设置；保留并整合当前 S3 管理能力。
2. 分区**重命名只修改 `displayName`**，`partitionId` 与底层 `scopeKey` 都不因改名变化；同一用户显示名称不重复。
3. 默认分区可设置、改显示名称、复刻，**永远不可删除**；默认分区当前底层 `scopeKey=''` 必须保持。
4. 分区复刻默认**不复制 Share、Collaboration（含别人项目 Mount / 自己发起的协同授权）、Static Resource、S3 凭证/映射、历史任务和审核工作流状态**；只复刻可复制的 Native 文件、目录及其业务元数据和 Content Object 引用。不得重新执行 Telegram 正文上传。
5. “挂载到分区”和“挂载到网盘目录”**统一为「挂载到我的网盘」**；位置可以是任意**原生目录**，包括某分区根目录，最终都产生一个独立 Mount 节点，**不能把远端根目录内容平铺合并**进本地目录。
6. Mount 是**特殊文件式叶节点**，底层应使用独立 `kind=collaboration_mount` / 独立表，而不是冒充普通 `file` 或 `directory`；它**不持有 Content Object 引用**，不产生远端数据副本。
7. **Mount 只能存在于自己的 Native Namespace**；任何 active 协同目录根及其所有后代，都禁止创建、放入或移动 Mount；含有任意后代 Mount 的目录及其祖先不能开启会覆盖它的目录协同；任何移动/重命名/跨分区操作都不能绕过此约束。
8. Mount **不得嵌套于另一个 Mount**；协同参与者对来自他人的协同页及其任何层级文件/目录，不得再创建 Mount、另开协同、Public Share、Static Resource、S3 / External 公开入口。必须避免甲挂乙、乙再挂甲等循环递归。
9. 在自己 Native 文件树递归时遇到 Mount **立即终止向下遍历**。删除 Mount 只删除自己指针；删除包含 Mount 的 Native 目录，只移除本地挂载记录和本地数据，绝不能删除远端协同内容。
10. 外来协同 namespace 中，按当前协同权限只能进行**常规文件系统操作**：读取、浏览、预览、下载；`editor` 可上传、新建目录、替换、改名、移动（仅在同一个授权协同 scope 内）、删除；`viewer` 不可修改。所有人都不能对外来内容二次授权开放。
11. Native ↔ Foreign、Foreign A ↔ Foreign B 的拖放与操作统一解释为**Copy，不是 Move**，不得使用“复制成功后自动删除源”的伪 Move；同一个授权协同 scope 内的普通 Move 仍可按权限执行。
12. Mount 内容默认不进入原生 S3、External API、Public Share / Static Resource；直接构造 API 路径也不得突破此限制。
13. 搜索保留“**所有文件**”（只搜索当前自己分区的 Native 文件，不包括 Mount 内文件），新增独立“**附加已挂载的协同内容**”开关。远端结果必须标注来源与导航上下文，不能伪装成自己的文件。
14. 角色模型预留并落实 `viewer/editor` 真实权限语义；旧的有效成员默认映射到 `editor`（维持已有能力），除非用户明确要求降权。改变角色/踢人/关闭协同必须让旧授权失效。
15. 同一个 Collaboration 可以在自己的不同 Native 目录甚至不同分区**挂多次**，各自有独立 `mountId/displayName`，但仍指向同一授权对象。
16. 被撤销授权的 Mount 仍在自己目录显示“访问已失效/已撤销”，允许移除，但不能继续列举、播放、搜索、复制或修改远端内容。不能自动复制源内容变成自己文件。
17. 新增功能不得破坏已上线的同一用户**Native 跨分区 Copy/Move**、Content Object 引用计数、静态资源保护、S3、审核以及现有独立协同页操作。

### 3.2 允许 Codex 根据实际代码调整的内容

以下均为**实现建议**，不是要求一字不差执行：数据表/字段物理命名、是否引入通用 namespace service 或轻量 resolver、具体 API URL、事务封装、索引设计、任务/恢复机制、UI 组件形式、分阶段提交粒度、历史数据迁移技术、缓存策略和测试组织。

允许用新的 `partitionId` 映射既有 `diskSpace`，也允许长期保留 `X-Disk-Space` 兼容适配；不强制全面修改所有旧 route。允许沿用现有 `client/disk-collaboration.js` 的独立视图/iframe 作为 Mount 的打开方式，而不强制重写成统一 File Explorer——**只要权限、上下文、导航和写操作边界得到完整保证**。

如果数据约束需要比下文样例更合理的 schema，请采用更适合当前 SQLite/WAL/Content Object 的设计；但必须解释为什么等价且如何证明不会误删或越权。

### 3.3 没有被用户指定的内容，禁止擅自变成承诺

“个人全局设置 / 当前分区设置”尚未列举每个具体开关；不要为了凑 UI 自创自动分享、二次授权、全局删除策略、S3 自动暴露 Mount 等高风险功能。可把当前已存在的设置迁入或汇总，并预留可扩展、带版本/校验的设置结构。新功能开关超出本次确认范围时应标注为待决，不能假装已被确认。

另外，当前 Collaboration 支持 `kind=file|directory`：挂载“协同页整体内容”不应暗中把单文件协同改写为目录协同。建议兼容 file grant 的单文件项目视图，directory grant 按目录树视图；如果本地现状下统一 UI 需要额外约束，先在实施记录中说明取舍，不得越权扩大源范围。

---

## 4. 底层概念一：Partition Identity

### 4.1 稳定的业务身份与兼容内部 scope

推荐逻辑模型（**字段为建议名称**）：

```ts
Partition {
  partitionId: string;            // 永久稳定的业务 ID
  ownerId: string;                // 此用户实际拥有的分区
  scopeKey: string;               // 永久稳定、兼容旧 diskSpace 的内部 namespace
  displayName: string;            // 用户可修改，禁止与自己其它有效分区同名
  isDefault: boolean;
  state: 'ACTIVE'|'DELETING'|'DELETE_FAILED';
  settings: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}
```

- 老分区 `diskSpace='影音'`：迁移为新永久 `partitionId`，保留 `scopeKey='影音'`，初始 `displayName='影音'`；后来改为“媒体库”仅修改显示名。
- 默认分区保留 `scopeKey=''`，`isDefault=true`。不同用户可各自设置默认分区显示名。
- 同一个用户有效分区的 `displayName` 不得重名；不同用户同名可存在。**不能因为底层旧 `disk_spaces` 是全局字符串表而错误地强迫所有用户共享一个 displayName。**
- **用户的 `partitionId` 与 `scopeKey` 必须按 `ownerId` 解析和授权**；纯传客户端 UUID、`X-Disk-Space` 或显示名都不能绕过归属检查。
- 历史上某个分区被删除后，即使用户又创建同名显示分区，也不能意外重新激活/连回旧数据。推荐保留 scope tombstone 并分配新的不冲突内部 scopeKey。新建非默认分区可使用不透明随机 scopeKey，而非直接用显示名。

### 4.2 必须特别关注现有 `createDiskSpaces()`

当前 `spaces.get(value)` 可能因为访问一个此前没有的字符串而**创建 Store 并登记全局分区**。新的读/验证路径（尤其 Mount resolver、分区删除、API 认证、S3 外部请求）不能依赖该方法来“检查分区是否存在”，否则错误或恶意输入会在检查过程中反向创建 scope。

建议拆出明确的：`resolveAuthorizedPartition(ownerId, partitionIdOrLegacyScope)` / `getExistingStore(scopeKey)` / `createPartition()`，分别承担**查找授权、现有 Store 访问、显式创建**。是否需要保留 legacy `get()` 的副作用由兼容调用决定，但不能把它作为安全边界入口。

现有 `disk_spaces` 是全局登记，`space_usage` 中有 `appId/userId/diskSpace`。迁移时应从实际文件、目录、使用记录、协同、分享、静态资源与 S3 映射反查用户分区，保证空分区、很少访问的分区、默认分区及外部应用的历史分区不遗失；**绝不能把全局 scope 目录直接等同为某用户的分区集合**。

### 4.3 全局与分区设置

UI 的齿轮面板划分：

```text
⚙ 网盘设置
  个人网盘全局设置
    └─ 已有适合全局管理的选项 / 后续扩展入口
  当前分区设置
    ├─ 修改显示名称
    ├─ 新建分区 / 管理分区
    ├─ S3 配置（沿用现有启用、轮换、停用等）
    ├─ 复刻分区
    └─ 删除分区（默认分区无此能力）
```

建议设置可版本化、可校验，明确全局默认值与分区 override 的作用范围；敏感 Token/S3 secret 不放进随意回显的普通 settings JSON。现有本地 UI 偏好（排序、列表/网格等）若迁移为服务端设置，要考虑旧 localStorage 兼容和多设备同步，但这不是擅自新增新设置的许可。

### 4.4 分区删除是生命周期任务，不是删 `spaces` 行

推荐阶段：**preview impact → 冻结该用户该分区写入 → 有条件执行 → 清理引用/授权 → 最终完成/可恢复失败状态**。

删除前验证：不是默认分区；属于当前用户；确认没有 active owner collaboration（否则拒绝并指引先结束）；无未完成/未知状态的上传、修复、转存、恢复、锁/lease 等；涉及静态资源/分享/S3 的撤销影响已明确告知；分区删除不得波及另一个用户恰好使用同名旧 `diskSpace` 的数据。

删除过程中：只删除此用户 Native Logical Files/Directories 和自己的 Mount Records；普通文件释放 Content Object 引用、由现有 content cleanup 判定是否最后引用，**不直接遍历 Telegram messages 删除**；撤销该用户在该分区的 Share/Static Resource/S3 credentials（已有授权可能通过 token 缓存，须保证服务端确实拒绝后续访问）；不能清理源 owner 的 Collaboration/Content。保留任务状态、失败恢复和审计计数，避免“事务中途失败显示已删除”。

建议普通分区删除弹出影响摘要：文件/目录数量、挂载数量、已分享/静态资源数量、S3 状态、活动任务、活跃自建协同数。危险操作二次确认。**不要在同一个同步 SQLite 长事务中执行任何网络操作**。

### 4.5 复刻分区

复刻是**创建新的 Native 分区快照**，不是覆盖已有分区，更不是“引用同一批 Logical File 记录”。应创建新目录行、新 Logical File ID，且其 Content Object reference 指向原内容；业务元数据允许通过明确 allowlist 克隆，绝不能复制 source owner/session/share/collaboration grant/token/审核工作流凭据。

默认仅复制：原生目录结构、可复制的 Logical Files、合法文件 metadata、用户自定义属性；不复制共享授权、静态外链、S3 secret/credential、活跃任务、历史操作与 Mount。处于 `blocked/deleted` 或 review 未决的源实体应遵循现有审核权限，**不允许复刻绕过审核**；建议跳过并清楚报告数量，而不是生成干净的“active”副本。

大分区须先形成一致性快照/冻结视图、预检文件数与存储配额/深度/冲突，采用一次事务或**分批可恢复 + 未完成分区不可见**模式，不可暴露半克隆的可写分区。处理失败应可重试/幂等清理，不能留下幽灵 refs。成功回报复制文件/目录数、跳过 Mount/审核项目数。不调用 PoP、不调用 Telegram `sendDocument/sendMediaGroup`。

---

## 5. 底层概念二：CollaborationMount

### 5.1 数据模型与安全含义

```ts
CollaborationMount {
  mountId: string;                 // 自己的本地挂载身份
  ownerId: string;                 // 挂载者本人，不是远端协同发起人
  partitionId: string;             // 挂载者的 Native Partition
  parentPath: string;              // 仅是本地原生目录路径/等价稳定父节点引用
  displayName: string;
  collaborationId: string;         // 指向一个已经存在的 Collaboration Grant
  createdAt: number;
  updatedAt: number;
  lastKnownTitle?: string;         // 仅展示缓存，不参与授权
}
```

- 不复制 `remoteOwnerId`、`remoteDiskSpace`、`remoteRootPath` 和 `role` 后长久信任；每次访问 `collaborationId → 当前 grant → 当前 owner/scope/root/role`。
- 不为挂载目标的每一个文件创建自己的 Logical File，也不增加 Content Object refCount；Mount 不承载 Telegram 内容。
- 可以在不同 Native 目录挂同一协同多次，每个 Mount 有独立 `mountId`，重命名仅修改自己的显示名。
- `kind='collaboration_mount'` 不是 `file` 和 `directory`；列表、排序、图标、选择、右键菜单、键盘行为、拖放和历史导航应显式识别第三种节点。
- 不允许在 Mount 之内放 Mount，也不允许将别人的协同目录/文件再设置为自己发起的协同。建议对**自己的** collaboration 做自身挂载时拒绝（用户目标为“别人的协同项目”，且能减少自指入口）；如 Codex 发现必须兼容现有“自己管理的协同页”入口，可保持管理入口但不创建 Mount。

### 5.2 Mount 作为特殊叶节点

在 Native 目录树中：

```text
我的分区 / 项目 / 
  ├─ main.js               （原生 logical file）
  ├─ 归档/                 （原生 directory）
  └─ 🔗 同事的共享项目       （collaboration_mount，叶节点）
```

Native 的 `getDirectoryTree`、递归删除、分区复刻、S3 LIST、Static Resource/Share 遍历、缓存统计及目录大小、文件数量均**不得递归穿透 Mount**。父目录统计只包括自己的 Native 内容，可单独给出 `mountCount`。打开 Mount 才进入外来协同的**另一 namespace**。挂载项本身不提供普通文件的下载/替换/MIME、Content Object 或媒体预览能力。

Mount 本身的操作：

| 操作 | 真正作用 |
|---|---|
| 打开 | 解析当前协同授权并进入其原有协同视图/等价统一导航 |
| 本地改名 | 只修改 `CollaborationMount.displayName` |
| 在自己 Native 目录间移动 Mount | 只改自己 `parentPath`，重验目标 topology；不移动远端 |
| 移除挂载 | 只删除自己的 Mount record，不改变协同 membership、owner 数据、Content refs 或 Telegram |
| 删除包含 Mount 的 Native 上级目录 | 删除该上级目录自己的 Native 内容并移除其后代 Mount records，**绝不递归到 foreign** |
| 远端 owner 撤销/踢人/结束协同 | 挂载项保留为“不可访问”，仅可本地移除；远端请求必须立即拒绝 |

### 5.3 挂载完整协同页：目录级和文件级

现有 Collaboration Grant 支持 `kind='directory'` 和 `kind='file'`：

- 对目录级协同：Mount 打开后显示授权根目录及其合法后代，遵守 owner scope 的当前 CRUD/role 规则。
- 对文件级协同：Mount 仍是本地“协同项目”入口，打开后显示受邀单文件或专属编辑视图；**不能伪造一个可随意遍历 owner 其它目录的根目录**。
- 对失效 grant、删除/审核不可见目标、owner 移动协同根目录：按当前 grant 动态解算，不使用历史 `path` 作为独立授权。

### 5.4 统一名称冲突规则

同一 Native 父目录中，文件、目录、Mount 的名字应处在**同一个命名冲突域**；不能出现两个相同名称但不同类型的可见节点，也不能由 S3 写入同名 Object 踩掉 Mount。应统一复用当前 `normalizeSegment/assertFreeName` 等校验规则，并补跨三种节点的唯一性校验及并发安全；名称相等策略、大小写规范跟随当前产品，不能悄悄更改旧文件命名语义。

### 5.5 Native 目录 Rename/Move 牵连挂载

现在目录主要基于路径，若本地目录 A 含 `A/B/MountX`，将 A 改名/移动后，Mount 的 `parentPath` 必须和文件/目录路径在**同一原子变更**中同步重写；不能单独异步更新导致孤儿 Mount。Codex 可以使用现有前缀重写事务，也可引入更稳定的 parent directory identity，只要兼容旧路径与历史导航即可。

---

## 6. 底层概念三：Namespace Resolver

所有 Mount 相关读取/写入都通过单一服务端 namespace 解析/授权入口，不允许把用户视觉路径字符串直接转换成远端物理路径。

### 6.1 推荐 Context

```ts
NativeContext {
  kind: 'native';
  actorId: string;                // 当前已认证用户
  partitionId: string;
  scopeKey: string;               // 服务端解析而非相信显示名
  path: string;
}

CollaborationContext {
  kind: 'collaboration';
  actorId: string;                // 当前 viewer
  mountId: string;                // 从自己的 Native 挂载实例进入
  collaborationId: string;
  grantVersion: number;
  dataOwnerId: string;            // 服务端由当前 grant 解出
  scopeKey: string;
  rootPath: string;
  relativePath: string;           // 相对协同授权 root；不得越界
  role: 'viewer'|'editor';
  capabilities: string[];
}
```

持久化记录和 API 不必完全照此命名；**绝不能让客户端传来的 `dataOwnerId/rootPath/role` 成为权威**。`mountId` 必须先校验属于当前用户当前 Native 分区，再查当前有效 grant；原有独立 `/disk-collab/...` 入口可没有 mountId，但也必须使用**同一套** grant/role/capability 校验，防止因不同 UI 入口而产生权限差异。

### 6.2 解析流程

```text
认证 actor
   ↓
resolve 本人 Partition （native）或本人 Mount Record
   ↓
若 Mount：current collaboration grant + active member + role + grantVersion
   ↓
canonicalize relativePath；严格校验 root / 文件 ID 属于授予的文件或目录树
   ↓
计算 capabilities 和真实 dataOwner/scope
   ↓
路由到现有 Store/Content 操作
```

- `..`、重复分隔符、Unicode/编码变体、百分号双重编码、路径前缀误判（`a/b` vs `a/b2`）不得绕过边界；统一路径正规化，边界比较必须以真实 path segment 判定。
- 只允许 owner 当前 grant 覆盖的文件/目录；只检查 path 不足以覆盖直接按 `fileId` 操作，file 也必须属于当前授权范围。
- 用户踢出、grant disable/role downgrade 后，当前视图、搜索、缓存接口、长时间上传、Operation、读流/Range、内容 Copy/lease 都要重新验证或使用短时版本绑定。旧 token/旧角色不能靠缓存继续写入。
- `mountId` 不暴露旧协同邀请 token；Mount 的存在本身不构成分享能力，也不能给其他用户提供访问权限。
- 当 grant 失效时，Native 列表可显示 `status=inaccessible` 及最后一次用户可见名称，不应泄漏当前 owner 新目录详情。

### 6.3 viewer/editor 实际权限矩阵

| 权限 | viewer | editor | 原生 owner |
|---|---:|---:|---:|
| 列举、搜索授权内容、预览、stream、下载 | ✓ | ✓ | ✓ |
| 上传、新建文件夹、重命名、替换、授权范围内移动/删除 | — | ✓ | ✓ |
| 管理协同成员/邀请/角色 | — | — | ✓（其自建协同） |
| 新建 Mount / 再设 Collaboration / 对外 Share / 静态资源 / S3 公开 | — | — | 仅在自己 Native namespace 按原有权限执行 |
| 修改远端分区设置、超出 grant 根目录操作 | — | — | 不适用 |

现有 `members[]` 需要升级为可版本化角色结构，历史有效 member 默认 `editor` 以维持既有功能。建议 role change 与 `memberVersions/grantVersion` 或等价版本绑定同步生效；所有 `POST/PATCH/DELETE`、修复/替换/上传分片/恢复、批处理、Copy-to-foreign 必须统一鉴权。不要只在页面隐藏按钮，也不要只拦 `/collaboration-scope` 的首个请求后让后续异步任务继续无限写入。

### 6.4 外来 namespace 不具有授权型资源

协同 Mount 内不得：

- 再创建、挂载、邀请新的 Collaboration；
- 将任一层级子目录/文件创建普通 Public Share 或 Static Resource；
- 开启 S3/External API 对外公开访问；
- 管理协同 owner 的 Partition 或外链。

这些限制不仅针对 UI，还需覆盖直接 API、Share 创建、静态资源配置、S3 LIST/GET/COPY/PUT/DELETE、全局搜索、分区转存以及后来新增的其它间接入口。对 Native 父目录本身开放静态资源时，也必须确保 Mount 内容不会被后续递归泄露。

---

## 7. 底层概念四：Mutation-Scope 与 Topology Invariant

### 7.1 真实约束（不可由 UI 代替）

对任意 Native scope 中有效 Mount `M`，以及由该 scope owner 创建的有效目录级 Collaboration root `C`：

> Mount 所在父目录 **不得等于** `C` 或属于 `C` 的任何后代。反之，任何打算把一个 Native 目录开启成 Collaboration root 的操作，若其整个后代树已有 Mount，必须拒绝。

同时，Mount 永远不能有 Foreign children；任何外来协同树不能返回/产生 Mount Node。这使 `Native → Mount → Foreign` 成为一次**终止于单个 foreign namespace 的跳转**，不可能形成 `A → B → A` 循环。

**重要精确性修正**：禁止的是 **祖先/后代相交**，不是“同一个父目录下出现 Collaboration 与 Mount 两个兄弟节点”。例如把一个协同根目录移动到 `X/CollabRoot`，而 `X/OtherMount` 仍是兄弟，不应仅因 X 下存在 Mount 就一概拒绝；应检验**移动后的真实拓扑**和其它既有保护规则，而不是简单判断“目标父目录有没有任何 Mount”。

### 7.2 受约束的操作表

| 操作 | 必查不变量 / 处理 |
|---|---|
| Create Mount | 目标是本人 Native 且真实存在；不在任何 active 协同目录 root/后代内；名称未冲突；当前仍有源 grant 权限。 |
| Enable Collaboration on directory A | 必须扫描 A **所有层级后代**不存在 Mount；检查已有目录协同/静态资源保护、owner 权限。 |
| Rename/Move Mount | 仅在自己的 Native namespace；新父目录不能处在 active Collaboration subtree，不能覆盖同名资源；更改仅本地。 |
| Rename/Move Native directory | 校验移动后所有 descendant Mount 与 active Collaboration roots 的相交关系；更新其后代 Mount 的本地 `parentPath`；已有协同 `relocateDirectory` 同步处理。 |
| Native 跨分区 Copy/Move | **保留 S6 已有语义**；将 Mount 作为特殊节点（默认不穿透）并在移动/复制计划中重新校验目标 topology；禁止把 Mount 默默复制成远端数据。 |
| Native recursive delete | 只遍历 Native nodes；移除本地 Mount record，不递归 foreign；正确释放本人 Content refs。 |
| Foreign 同 grant 内 Move/CRUD | `editor`、根目录边界与静态资源/审核限制都必须满足；不允许把内容移动出 grant。 |
| Foreign ↔ Native / Foreign A ↔ Foreign B | 仅显式 Copy；源具有读取权限，目标具有写入权限；源不删除，失败不改变源。 |
| Share/Static Resource/S3 | 不接受 `collaboration_mount` 或其 foreign descendants；外部客户端无法借虚拟路径递归进入 foreign。 |
| Partition delete/clone | Delete/clone 都按 Native namespace 遍历，遇 Mount 停止；不得将 Mount 关联的 foreign data 当成本地数据。 |

### 7.3 并发与事务

不能仅靠浏览器预校验，必须在同一协调边界验证并提交：`createMount`、`moveMount`、`enableCollaboration`、`rename/moveDirectory`、Native 跨分区转移、分区删除等。推荐利用 SQLite `BEGIN IMMEDIATE` / `persistence.atomic()` 或等价 CAS/revision 机制，使：

```text
resolve current owner/scope/grant + read topology
          ↓
validate post-operation topology
          ↓
write related records (directory/collaboration/mount)
          ↓
COMMIT
```

不能出现 T1 “A 没 Mount，所以开启协同” 与 T2 “A/x 没协同，所以插入 Mount” 两个并发都成功的写偏斜。需要增加必要索引/约束；**服务端统一 validator，不在不同 routes 复制数套不一致 if**。当前 repository 的 `atomic()` 只支持同步工作；网络、文件上传、Telegram、远程消息获取、长任务均在事务外处理，最终再次验证并短事务提交。

### 7.4 跨边界 Copy 不等于任意共享 Content

授权 Copy 的推荐路径：

```text
validate source grant + source file + review
       ↓
validate destination namespace + capability + name/depth/limits
       ↓
resolve source Content Object + protective lease
       ↓
create a NEW destination Logical File + Content ref
       ↓
commit, release lease
```

对于明确获授权、由源协同页主动复制的文件，可以复用当前 S6 的 Content Object Copy 能力，而不需要让用户重新下载正文/做陌生 hash PoP。**但不能因持有 `contentId` 就绕过当前用户的 source read / target write / review / backend 兼容性校验**。若该 Content 在现有存储 backend 下无法直接安全复用，应依照原系统已有的受控 fallback 或明确拒绝，而不是默默新造 Telegram `file_id` 或无证越权。

特别注意当前 `copyGrantedItem()` 的语义与 `contentCopyGrant`，以及 `POST /spaces/transfer` 的“同 owner、跨 Native 分区”的事务逻辑都已存在；不要直接拿任一 helper 不经语义检查扩展到 Foreign A→B，也不要意外破坏已经存在的 Native Move。

---

## 8. 协同页 UI、拖放、搜索与导航

### 8.1 顶部齿轮设置

- 在 `telegramDriveRefreshBtn` **紧邻左侧**放齿轮设置按钮；桌面与窄屏/折叠布局都必须能访问，避免被旧的头部溢出菜单、分享按钮排序挤走。
- 点击展示全局设置与当前分区设置两个清晰区域；新建/管理分区和 S3 现有选项整合进来，不保留两套相互冲突的设置事实源。
- 分区切换器显示 `displayName`，内部提交/导航记录使用稳定 `partitionId`（legacy `scopeKey` 仅兼容）。改名后不影响外部 S3 bucket 的内部映射、不丢路径/operation、不开新分区。
- 分区删除和复刻需预览影响、危险操作二次确认、后台任务进度与失败恢复；不能仅靠“按钮点击成功”显示完成。

### 8.2 在我的 Native 网盘挂载协同

可以从现有“协同列表/协同页”增加「挂载到我的网盘」，调用已有树形目录选择器选择**自己的**目标 Native 分区/目录。不得把这个功能拆成“挂载分区”和“挂载目录”两种不同语义；分区根也是合法 parentPath `''`。填写可编辑本地显示名，校验重名与防嵌套后创建 Mount。

列表中的 Mount 有单独类型、图标/来源提示、独立菜单「打开、重命名挂载、移动挂载、移除挂载」；**不能展示成普通可下载文件或文件夹**。进入后可暂用已有独立协同视图实现，视觉上维持从 Mount 返回 Native 目录的导航路径，并保留触发它的 mountId（同一协同多处挂载时尤其重要）。

### 8.3 拖动与选择

- Native 内部 Move/Copy 保留原产品操作；Native 分区之间继续支持当前已有 Copy/Move。
- **跨 Mount 边界**的拖动统一显式 `copy`，UI `dropEffect`、确认文字、任务标题和最终结果不能写成 Move；源不会被删除。
- Mount 节点本体的本地 Move 与“从 Mount 内复制一个文件”必须是两种独立操作，不得把 Mount 的拖动变成导出整个远端项目。
- 危险批量操作（删除、重命名、Move）默认要求所选实体处于同一个 mutation namespace；混合 Native/多个 Mount 的选择不应交给旧的单一 owner/path 批量 API。读取/下载/显式分批 Copy 可安全分类处理。

### 8.4 搜索两个独立选项

- **「所有文件」**：搜索当前本人分区全部 Native 文件（不跨分区、绝不递归进 Mount），保留当前目录搜索默认行为。
- **「附加已挂载的协同内容」**：在本人的搜索结果之外，追加本分区已挂载、当下仍有权限的 foreign collaboration 结果。两个开关应能清晰表达“Native 范围 + 是否额外搜索已挂载协同”，不要因为未开启全局 Native 搜索就静默把 foreign 冒充当前目录 Native 项。
- 在 Mount 内搜索时，以该 Mount 的有效协同 root 为上界，不能从远端协同搜索跳到 owner 其它目录。
- 结果返回 `origin=collaboration`、`mountId`、`collaborationId`、`relativePath/fileId` 等导航上下文；同一协同多次挂载时避免重复执行搜索和重复展示同一文件，可按协同查询去重并选定可导航的 Mount；拒绝旧角色、过期授权或 review 不可见的结果。
- 后端需为多个 Mount 的联合搜索设置上限、取消/超时策略、并发限制与分页/结果截断说明；不得暴露其他用户的文件存在性/路径。

---

## 9. 分区删除、复刻与已有系统的牵连清单

必须逐条验证以下入口不会把 Mount 当本地目录或误删共享内容：

1. `server/disk-api.js`：`createDiskSpaces()`、`/spaces`、`/spaces/transfer`、`/list`、`/tree`、`/search`、`/directories`、文件 CRUD、批量删除、operations/upload/recovery、`/collaboration-scope/:id`、静态资源路由、浏览器/External 分别授权路径。
2. `server/telegram-drive.js`：路径 normalize、`assertFreeName()`、`getDirectoryTree/list`、目录 rename/move/recursive delete、文件 replace/copy、review tombstone、sourceApp/metadata。
3. `server/disk-collaboration.js`：owner target、`authorized`、invite/member role & version、`protectDirectory`、`relocateDirectory`、file grant 与 directory grant、disable/kick 的生效范围。
4. `server/disk-repository.js`：新 Partition/Mount 表或等价持久化方式、schema migration、WAL、transaction/CAS、持久化失败时内存 reload、`foreign_key_check` 和索引。
5. `server/disk-content-repository.js`：Content Object refs/leases、批量逻辑复制、删除时的最后引用确认、后台清理、同内容多 Logical 的正确关系；Mount 本身**不**增加/释放 Content refs。
6. `server/disk-shares.js`：snapshot/递归目录选择不能跨 Mount，foreign node 不能进入公共分享。
7. `server/disk-static-resources.js`：既有 `protectDirectory/protectFile` 保留；Mount 不得是静态目标，也不可通过开放 Native 父目录间接遍历到 Mount 内容。
8. `server/object-storage.js`、`server/s3.js`、`server/s3/*`、S3 credential/bucket map：保留用户现有 Native S3 行为；S3/External 不展示 Mount、不允许虚拟 foreign 路径；同名写入不可覆盖 Mount；删除分区时只废止该用户凭证/映射。
9. `server/disk-operations.js` / progressive upload/recovery：在分区冻结/删除、grant 降权/撤销时处理长任务的并发与最终提交检查；客户端切分区不能改变已经发出的异步 operation 身份。
10. `client/disk-ui.js`：头部刷新左侧齿轮、原分区/S3 面板整合、第三类 Node 列表/排序/操作、搜索选项、跨分区 Copy/Move 与 Mount Copy 互不混淆。
11. `client/disk-collaboration.js`：现有协同页 viewer/editor、打开 Mount 的上下文与返回导航、原有跨端拖动及触控手势。
12. `client/disk-copy-picker.js`、`client/disk-directory-picker.js`、`client/disk-client.js`：目录选择器不得误允许外来路径作为 Mount parent；请求绑定明确 partition/scope/context，防止分区切换后旧回调落到新分区；保留原有选择器功能。
13. 既有 `docs/overview/*`、`docs/telegram-drive-content-objects.md`、`docs/devlog/dev-2610-features.md` 等文档：以源码为准更新有漂移的条目，避免文档继续写“JSON/未支持 S3”这样的历史状态。

---

## 10. Schema、迁移与数据安全建议

### 10.1 建议持久化结构

可在现有 SQLite generic repository 中增加 `partitions` / `collaboration_mounts` 等 domain tables，或选专用结构化 SQL 表；**必须明确作用域**：

```text
Partition unique identity:
  partitionId PK
  UNIQUE(ownerId, scopeKey)    // 历史同一个 scopeKey 跨用户可以存在
  UNIQUE(ownerId, normalizedDisplayName) WHERE active
  UNIQUE(ownerId) WHERE isDefault

Mount identity:
  mountId PK
  FK(ownerId, partitionId) / 经过验证的分区关联
  collaborationId 当前真实 grant ID
  INDEX(ownerId, partitionId, parentPath)

Visible name collision:
  同 owner + partition + parentPath + name 中
  native-file / directory / collaboration_mount 互斥
```

实际 SQL 约束语法、如何在旧 generic `disk_files/disk_directories` 的独立表间做到三类型名称原子唯一，由 Codex 根据代码决定。建议使用统一 namespace-entry reservation 或同事务验证/写入；不能让两个并发请求分别成功创建同名 file 与 Mount。

### 10.2 迁移策略

- 对已知历史用户/默认分区、实际有数据的 scope、S3 使用与 collaborations 的 scope 建立稳定 Partition；重复运行幂等。
- `scopeKey` 绝不在迁移或改名时批量替换，避免破坏 `disk_content_refs(scope,logical_file_id)`、分享、static、operation、S3 等既有关系。
- 不能通过 `spaces.get(nonexistent)` 自动创建来弥补缺失记录；需要审计并显式补录合法历史分区。
- `members[]` 的有效旧成员迁移到 `editor`，保留旧 grantVersion/memberVersions、邀请撤销行为；所有旧协同链接继续有效，不得突然默认为 viewer。
- 如果有 orphan mount 或协同 target 已失效，记录为失效挂载供用户清理，不得强行访问远端、删除 owner 记录或重复复制数据。
- 做迁移前有数据库 backup、schema 版本记录、回退/恢复方案；不能对生产环境原始 SQLite 直接做无备份的批量破坏。
- 需检查 `disk-spaces/<sha256(scopeKey)>` 及其它旧 Store 路径；改 `displayName` 不应更改 hash 路径；删除后重建同名也不能意外读取旧 Store。

### 10.3 生命周期与幂等

对分区复制/删除等规模性任务，建议 `operationId` 与幂等 token 绑定 `(ownerId, sourcePartitionId, targetPartitionId, requestId)`；失败阶段保存进度/可重试状态。不可把已完成的 Content ref attach 再附加一次；不能在事务半完成后对客户端报告成功。删除任务在退出/重启恢复后不应继续被旧 credential 修改。保留清理债务和可审计的影响摘要，不要将 Telegram cleanup 失败误判成 Logical 文件完全可恢复。

---

## 11. 实施顺序建议（允许 Codex 调整，但不能颠倒安全依赖）

**阶段 0：代码核对与迁移预演**。确认本地 HEAD、未提交改动、已有测试、数据量；梳理前述 routes/表与最近提交差异；确定 migration、backup、compatibility 方案。记录只读基线与已知风险。

**阶段 1：Partition Identity**。新增 owner-scoped Partition records、默认分区/历史分区幂等迁移、稳定 ID/name/scope 分离、授权解析；保留旧 `X-Disk-Space` 等接口兼容；先补分区改显示名称与设置读取写入测试。

**阶段 2：Mount schema + Name/Topology validator**。先建独立 Mount 存储和统一名称冲突约束；把 `createMount/moveMount/enableCollaboration/moveDirectory/cross-space transfer` 纳入同一事务视角的拓扑校验；覆盖递归删除和 parentPath 重写。

**阶段 3：Namespace Resolver + viewer/editor**。复用/增强现有 `/collaboration-scope/:id` 与 `authorized/memberVersions`，老成员升级 `editor`；确保所有 existing routes、长任务及独立协同页都按角色/有效 grant 受控；禁止从 foreign 创建分享/静态资源/Mount。

**阶段 4：Mount 只读接入与 UI**。新 Mount 能创建、展示、打开/返回、重命名、移动和移除；失效显示不可访问；S3/External/Static/Share/recursive 不穿透；确保旧网盘和旧协同页无回归。

**阶段 5：Foreign editor 及跨边界 Copy**。正常 CRUD 在同 grant 内；Native↔Foreign/Foreign A↔B 的 Copy 基于现有 Content ref/leases；明确拒绝跨 foreign 的 Move；测试后再启用拖放。

**阶段 6：搜索 + 齿轮 UI + 分区复刻/删除**。复用旧 S3、设置面板和目录选择器；实现 Native 搜索与附加 Mount 搜索；分区 clone/delete 以事务与操作恢复为基础，**最后开启高风险删除能力**。如已有成熟基础可调整顺序，但不得在 Mount/Content lifecycle 未安全定义时提前放开递归删除。

**阶段 7：回归、验收与交付**。完整测试、端到端模拟、多用户并发与失败注入、文档/开发日志更新、基线对照。实施过程中每阶段提供变更范围、是否偏离指南与原因、验证结果、未决事项。

---

## 12. 必须覆盖的测试矩阵（最低标准）

### Partition 身份及设置

- 旧 `diskSpace='影音'` 重命名为“媒体库”，其文件/目录/Content refs、分享/协同、Static/S3、历史 Operation 和存储路径均保持；别的用户同名旧 scope 不受影响。
- 默认分区不允许删除；默认分区允许改显示名/设置/复刻；只有 `displayName` 变化，不修改 `scopeKey=''`。
- 相同用户分区显示名冲突拒绝；不同用户相同显示名不串数据；删除后用原显示名创建新分区不复活旧数据。
- `GET /spaces` 与新身份解析、旧 `X-Disk-Space`、不同 App scopes、空分区/S3 分区兼容；未知分区请求不能暗中生成 Store。
- Settings 与旧 UI 偏好/S3 凭证逻辑一致，默认分区和普通分区权限一致但删除保护不同。

### 复刻 / 删除

- 复刻目录、Logical 文件与元数据，ID 全新、Content refs 共享且计数正确；无 Telegram send；源不变。
- 默认跳过 Mount、Share、Collaboration、Static Resource、S3，且数量反馈正确；blocked/deleted 不通过复刻洗白。
- 复刻大数据中断/崩溃/重试：无半可见目标、不重建重复 refs；预算/限制/名字冲突处理一致。
- 删除普通分区前阻止 active 自建协同与未完成的任务；删除时 Static/S3/Share 无效、Mount 只移除自己、Content 最后引用仍按原机制清理。
- 甲、乙使用相同 legacy `scopeKey`，甲删分区不能动乙；同 Content 被多分区/用户引用时物理 anchor 不删除。

### Mount 与拓扑

- 在 Native 根目录、深层目录可 Mount；同一 Grant 多次 Mount；本地 rename/move 不更改 owner/远端协同根路径。
- 不能在 Mount 内创建 Mount；不能将含 Mount 的 Native 任意祖先目录设为 active collaboration；不能在 active collaboration root 及任意后代创建 Mount。
- 通过 directory move、rename、Native 跨分区 Copy/Move、协同根移动、并发 enable+mount 仍无法绕过；**Mount 与协同目录仅为兄弟节点时不误拒绝**。
- 目录改名/移动后 descendant mounts `parentPath` 全部跟随；失败回滚不遗失挂载；同名文件/目录/Mount 并发创建不能同时成功。
- 删除 Mount 不调用 foreign delete/content release/Telegram；删除有 Mount 的 Native 上级目录仅删 Native；Native 目录大小、Quota、文件数不包括远端内容。
- 拥有 U1→U2 与 U2→U1 的相互协同 grants 时仍不形成 Mount 循环、跨 namespace 递归或无限搜索。

### 授权与 roles

- 旧 member 迁移 editor；viewer 可以 list/search/stream/download，但不能 upload/mkdir/rename/replace/move/delete。
- role editor 仅能在协同根内 CRUD；不能访问 owner 私密同级目录，也不能创建二级协同、挂载、外链、Static、S3。
- kick/disable/downgrade 立即拒绝 Mount 读取/写入与原独立协同页操作，正在进行的上传、分片、修复和最终 commit 也不能越权完成。
- 文件级协同只暴露受邀 file，目录级协同不泄漏 grant 根外文件；非法 ID、`../`、编码绕过、伪造 mountId/owner/role/partitionId 均拒绝。

### Copy/Move、Share、S3、搜索

- Native 同一用户跨分区 **copy 和 move 仍工作**，且不发生 Telegram 重新上传；带 Mount 的树不得把外来文件复制/移动/删除。
- Native→Foreign、Foreign→Native、Foreign A→Foreign B：Copy 在授权允许时成功，源保留；Move 明确拒绝；无权限或 backend 不兼容时安全失败。
- 直接 `/static-resources`、Share、S3/External path 请求与 Public link 无法通过 Mount 指针间接开放/访问 foreign；Native 同名 S3 PUT 不覆盖 Mount。
- `所有文件` 只搜本人当前分区；开启“附加已挂载的协同内容”只加入当前有权限的 Mount；同协同多个 Mount 查询去重且可导航；权限撤销后搜索结果失效。
- 旧独立 `/disk-collab`、已有邀请/分享/Static、S3 Bucket 与 FolderSync 类型普通原生客户端行为不回归。

### 数据完整性和故障注入

- SQLite transaction fail/CAS conflict、多进程/多 tab/并发、浏览器切换分区、系统重启、中断克隆/删除、cleanup 重试、Content lease 到期、复刻与删除同时执行。
- 检查 `PRAGMA integrity_check` 与 `foreign_key_check`；Content refs 不丢不重；无 remote owner 数据误删；无因 partition displayName 更新导致的 S3/分享失效。
- 建议以当前 `tests/disk-collaboration*.test.cjs`、`disk-content*.test.cjs`、`disk-static-resources.test.cjs`、`disk-directory-actions.test.cjs`、`disk-repository.test.cjs`、`disk-sharing.test.cjs`、`disk-api.test.cjs` 为基础新建覆盖。Node 版本遵守项目 `package.json` 的 `>=24.15` 需求，使用 `node --test` 和必要的 UI/HTTP 端到端测试。

---

## 13. Codex 可执行工作说明及变通边界

Codex 开始实现时应遵守如下顺序：

1. **读取本文及附件原讨论记录**，把用户明确同意的决策列为不可变产品约束，不得误读“挂载到分区”为另一个功能，不得误把 Mount 当物理目录/普通文件。
2. **核对本地当前代码**：输出 HEAD、分支、现有未提交改动；阅读 `docs/overview`、相关近月开发日志、最新代码与测试，以当前代码为技术事实源。若 HEAD 比 `b4bedfd…` 更新，先输出关键变化及对本方案的影响。
3. **允许技术性变通**：如 `partitionId` vs owner-scoped key、SQL 表结构、UI 框架、复用旧协同页、API 命名、事务分组与回滚实现；只要满足所有硬约束、兼容性和测试。推荐先进行最小侵入式实现，不进行与本需求无关的大重构。
4. **禁止静默产品性变更**：不改旧 `scopeKey` 作为改名手段、不删除默认分区、不让 Mount 在 foreign 下嵌套、不将别人的协同内容对外公开、不允许跨 Mount Move、不因复刻/删除误动 Telegram anchor、不随便取消 S6 已有 Native 跨分区 Move。
5. **遇到歧义时**：先根据本指南硬约束实现保守、安全、可逆的缺省行为；对于“全球设置具体开关”“是否首版实现复刻 Mount 的可选开关”等尚未确认的产品扩展，记录为待用户决定，而非自行变成需求。如需与硬约束冲突才能实现，应停止该危险子功能并说明阻塞点。
6. **每阶段必须形成证据链**：具体改动文件/函数、schema 与迁移步骤、对旧行为影响、测试输出、失败注入结果、兼容/rollback 策略。不要以简单静态正则测试代替关键授权、数据库和跨 scope 集成测试。
7. **遵守下一轮开发指令**：本指南本身不授权对任意分支提交、push；Codex 必须按届时明确指定的分支、提交与保留未提交改动要求操作。

### 成功交付的定义

一个用户可以安全地为自己的不同分区改显示名称、设置、复刻或删除普通分区；可以把别人已授权的完整协同项目作为可重命名/可移动/可移除的特殊 Mount 放入自己的任意 Native 目录；可以在 Mount 内按 viewer/editor 正确读写；可以明确复制文件跨 Mount 边界但不移动/删除源；可以搜索自己文件并按需附加有权访问的挂载内容；而 **S3、External API、Static/Public Share、普通目录递归及另一用户的物理 Content Object 永远不会因为一个 Mount 或分区管理操作被错误触达。**

**最终边界总结：`Partition identity` 提供稳定 scope，`CollaborationMount` 提供叶节点指针，`Namespace resolver` 负责当前授权，`Mutation-scope invariant` 负责拓扑与写操作安全。所有其余实现细节允许 Codex 基于真实代码优化，但不能弱化这些边界。**
