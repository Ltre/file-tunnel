# Drop2Tunnel S7：网盘协同挂载一体化与文件操作开发实施指南

> **交付对象**：Codex / 开发 Agent  
> **目标分支**：`dev/2609-s7-disk-partition-collaboration-mount`  
> **编写时远程 HEAD**：`d57e40dd51ac4d3fd5a180bb4452e507fbad2ae1`（2026-10-09 核对）  
> **需求依据**：用户提供的《粘贴的文本 (1)(20261009-053621).txt》中的完整问答及最后修正。  
> **本轮范围**：原编号 **1、2、3、4、6、7**。**原编号 5「目录全量下载」已明确搁置，不开发。**

## 0. Codex 执行说明：哪些必须严格遵守，哪些可以变通

本文是 **产品需求契约 + 最新源码调查 + 推荐设计 + 验收清单**，不是要求机械执行的逐行编码命令。

- **不可改变**：标有“必须/禁止/已确认”的业务语义、权限界限、数据归属、危险操作保护和排除范围。
- **允许因代码实际情况变通**：具体函数名、API 路由、新增表或复用旧表、组件拆分、样式、事务与任务调度方式、开发顺序。Codex 可采用更安全、维护成本更低的方案，但要保留相同的外部行为和数据安全性质，并在开发记录中解释重要差异。
- **不能借口灵活性偷换需求**：不能把 Web 原地浏览改回 iframe；不能把挂载人自己的分享记录落到原所有者名下；不能默认禁止再次分享；不能让 S3/External API 对挂载内容可写；不能把跨协同 Move 假装成 Copy；不能保留旧 300MB 限额；不能顺带开发已搁置的目录全量下载。
- **以运行时工作区为准**：开始前核对 `git status --short`、`git rev-parse HEAD`、`git diff --stat`、未跟踪文件及相应测试。文中 SHA 只作为“编写时已检视基线”，不是要求 reset、pull 或 rebase 到该提交。保护现有工作区，不自动清理/覆盖。
- **旧功能必须保留**：分区稳定 ID/scope、改名复刻删除、回收站、Content Object 引用、viewer/editor、Native 跨分区 Copy/Move、静态资源、分享、S3、旧协同列表全屏页面、原有上传恢复能力。
- **测试要真实执行**：代码存在不表示完成，测试文件存在不代表通过。无法验证之处明确标注，不能声称全功能通过。
- 本文自身不授权 `git add`、`git commit`、`git push` 或破坏性 Git 操作；执行时服从 Codex 任务的明确版本控制指令。

### 0.1 核心概念

- **Native**：用户自己某个分区内的文件、目录和 Logical refs。
- **Mount**：用户 Native 目录里的 `kind=collaboration_mount` **特殊叶节点指针**，不是 Native Directory，也不是 Logical File；挂载本身不复制远端文件和 Content Object。
- **Foreign Collaboration**：经 Mount 进入的协同授权 namespace；真正的文件/目录属于原所有者。Web editor 的 rename/move/delete 对原所有者的 Logical 资源生效。
- **Web 网盘**：登录后的浏览器网盘交互界面，可依照协同角色实施用户要求的编辑操作。
- **External 网盘 API**：对外第三方应用/API Token 渠道；对 Mount 及内部内容**只读**。
- **S3API**：S3 对象存储兼容接口；对 Mount 及内部内容**只读**。
- **Content Object**：物理内容与 Logical File 引用层；编辑时禁止原地改写被其它 Logical Files 共用的旧正文。

### 0.2 最终已确认的五项修正（覆盖早期中间讨论）

1. 网盘允许最大目录深度统一为 **30 层**；拖入文件夹中**所有文件总大小默认上限 500MB，允许在网盘全局设置中调整**。旧“固定 300MB”作废。500MB 不是目标网盘目录的存储容量。
2. **Web** 中可把 Foreign 协同内文件/目录 Move 到本人的指定分区/目录；可用“先完整 Copy，确认成功后再删除原来源”的方法，须处理部分完成和失败重试。
3. 受邀者对有权读取的协同文件/目录，**默认允许再次公开分享给别人**，无需额外向原所有者申请；以后细粒度 ACL 才限制指定资源。Share 记录仅在分享者自己的网盘中，原所有者文件不因这次分享被冻结。
4. **S3API 和 External 网盘 API**：Mount 指针与全部内部内容**只有只读访问**，允许列出/读取/下载；禁止上传、覆盖、移动、改名、删除及移除挂载。此规则不妨碍 Web 协同 editor 的合法修改。
5. **目录全量下载**延期，不再纳入本次实施及验收。

## 1. S7 最新源码调查结论（编码前重新核对）

| 源码位置 | 在上述 SHA 已观察到的情况 | 本轮切入点 |
|---|---|---|
| `server/disk-trash.js` | `archive()` 先获取 `root`，调用 `moveToTrash()`，再构造摘要；`summary()` 返回 name/path/originalParent/deletedAt/size 等 | 修复回收站原始名称/资料映射 |
| `server/telegram-drive.js` | `moveToTrash()` 有意将存储文件名改为 `:recycle:<id>`；`assertDepth()` 仍硬封顶 20 | 保留内部占位隔离、修正显示；升级深度 30 |
| `client/disk-trash-ui.js` | 列表依赖 `entry.name`，顶级资料简略 | 补齐真实名称、类型、大小、完整原路径、时间 |
| `client/disk-import-picker.js` | `accept` 执行前置校验、fetch stream 下载；忙时禁用按钮但缺乏旋转动画 | 增加与真实生命周期绑定的 spinner |
| `client/disk-ui.js` | Native 文件列表、预览、属性、搜索、多选、拖放；Mount 打开仍进入 iframe；顶部协同列表使用旧全屏视图 | Web 中 Mount 入口改为同一文件管理器原地导航，不改旧入口 |
| `client/disk-mount-ui.js` | 明确把 Mount 当本地叶节点；`open()` 建 iframe；管理 create/rename/move/remove | 复用 Mount 管理，不再用 iframe 承担 Native 挂载内容显示 |
| `server/disk-collaboration-mounts.js` | Mount 持久化/`resolve()`/grant 重查/嵌套检查/搜索已有 | 以现有授权与拓扑机制扩展 Mounted namespace |
| `server/disk-collaboration.js` | memberRoles、viewer/editor、grantVersion 存在 | 保留角色，扩展再次分享与实际操作限制 |
| `server/disk-api.js` | `/cross-scope/copy` 只接收 `mode=copy`；`/collaboration-scope/:id` 已检验权限/范围；`/list` Mount 单独返回 | Web 操作路由、Foreign→Native 安全 Move、Mounted resolve |
| `server/disk-shares.js` | 分享记录是 Native 文件 ID/目录树语义 | 增加“挂载者名下的动态协同分享” |
| `server/disk-static-resources.js` | 静态目标只识别本地 `file/directory` | 新增仅在 Mount 本体配置的开放方式 |
| `server/object-storage.js`、`server/s3/routes.js` | S3 list/stat/put/delete 等主要使用原生文件目录 | 投影 Mount 为只读虚拟前缀，拒绝一切指向 Mount 的写操作 |
| `client/disk-client.js` | 一批上传超过 100 个文件会拒绝，已有分片/Progressive/恢复机制 | 为递归文件夹上传组织合法批次，保留老能力 |
| `client/disk-ui.js::installDiskDrop()` | 从 `DataTransfer.files` 处理普通文件，尚无完整递归目录结构保留 | 枚举拖入的系统目录并预检 |
| `server/disk-partitions.js` | 版本化 `settings` 目前仅接受 `{version:1}` | 新增 owner 级全局设置，不把个人配置误放进某分区 |
| `server/disk-repository.js` | SQLite WAL/事务、Content refs、partition/mount/trash 表已存在 | 保持 schema 迁移与老数据兼容 |

此表仅是**源码实况**，不是“各功能已完成”的断言。如远程分支又更新，以实际本地 HEAD 为准并在开发记录中标明出入。

## 2. 需求 1：回收站正确显示删除前的文件/目录资料

用户看到错误示例：

```text
📄 :recycle:3dbb17d5-6924-4ecb-a15f-dc0909b47965
原位置：/fdsjaio · 2026/10/9 07:49:43 · 1 个文件
```

原文件实际上叫 `新建 Microsoft Word 文档.docx`。列表中**至少**显示真实文件/目录名称、删除前完整位置、文件类型、文件大小（目录则显示合计大小/文件数）、删除时间。例如：

```text
📄 新建 Microsoft Word 文档.docx
类型：Word 文档 (.docx) · 大小：18.4 KB
原位置：/fdsjaio/新建 Microsoft Word 文档.docx
删除时间：2026/10/9 07:49:43
```

**实现提示**：

- `telegram-drive.js::moveToTrash()` 有意将活记录名称改为 `:recycle:<id>`，并保存 `trashOriginalName`，用以避免和正常文件路径冲突。**禁止为了显示原名称直接取消这个内部隔离。**
- 检查 `disk-trash.js::archive()` 中的 `root` 是否为可变同一对象：若在 `moveToTrash()` 后读 `root.name` 被污染，应在移动前拍下 immutable `originalName`，或从 `snapshot.files[0]` / `snapshot.directories` 提取真实值。须核实引用关系，而不是只猜原因。
- `summary()`/UI 可增加 `type`、`originalFullPath` 等必要字段；对已经保存成 `:recycle:` 的历史脏条目，从可信 `snapshot` 或 `trashOriginalName` 恢复显示。无法还原则如实提示，不凭 ID 瞎猜。
- 恢复、永久删除、Content 引用/物理清理、同名检查、含 Mount 的 Native 父目录恢复逻辑必须保持。

**验收**：Word 文件、普通无扩展名文件、空文件夹、多级目录、非空目录、多分区、历史错误条目、还原冲突均正确；任何正常回收站 UI 都不展示内部 `:recycle:` 名称。

## 3. 需求 2：「查看协同列表」浮层两处关闭按钮固定

- 本条专指网盘顶部 **「查看协同列表」**打开的弹层/对话框，**不是**「协同中」管理 `body > section.disk-collaboration-popover` 小面板。开发时先核准 DOM。
- 右上角 `×` 与右下角「关闭」必须在面板内容长列表滚动时始终可见、可点击，不受内容一级容器的滚动条遮挡。
- 建议将通用 dialog/card 分成固定 `header`、**独立滚动的 body**、固定 `footer`；也可用可靠的 sticky 实现。校验 `flex/min-height:0`、z-index、窄屏、安全区及软键盘。
- 保留 Escape、点击关闭、历史状态还原；不得影响条目操作与**顶部列表点击某项后依旧全屏打开原协同页**的旧行为。

**验收**：超过 100 个协同项，滚动顶部/中部/底部、桌面/移动端，两个关闭按钮始终可用。

## 4. 需求 3：网页工坊「从网盘导入」按钮真实 Loading

- 对 `client/disk-import-picker.js` 的 `accept`/「导入所选」按钮增加明显旋转菊花及忙碌指示。
- Loading 从点击开始，持续覆盖规划源目录、下载选中全部文件、流读取与完整性校验、把导入结果交付调用方的全过程；成功关闭后消失，出错/取消时停止并正确回退。
- 当前代码已有 `busy=true`、`accept.disabled=true`、`finally` 恢复，不应再造一套与请求不同步的定时动画；扩展按钮装饰/`aria-busy`，继续展示当前文件/下载字节进度。
- 避免双击重复导入，允许失败后重试、取消后 Abort，禁止异步回调修改已销毁 UI。

**验收**：慢网速、多文件、大文件（含已有 100MB 规则）、失败、取消时动画准确启动与结束，无假完成或永久转圈。

## 5. 需求 4（核心）：已挂载协同项目在原生网盘里原地展开与操作

### 5.1 两种入口必须区别处理

**入口 A：在 Native 目录中点击已挂载的协同项目**

```text
我的网盘 / 当前分区 / 工作 /
  📁 本地文档
  🔗 张三项目            ← collaboration_mount，指针属于我
```

点击 `张三项目` 后**直接在当前网盘浮层的文件列表内进入 Foreign 协同范围**，展示 `我的网盘 / 工作 / 🔗张三项目 / src` 等面包屑。继续使用 Native 网盘的列表/网格、排序、多选、右键/长按、工具栏、预览、下载、属性、缓存、任务进度等体验；不要再为这种入口弹出独立的 iframe 协同页。

**入口 B：网盘顶部「查看协同列表」中的协同项目**

**保持 S7 原行为**：点击项目仍以全屏浮层打开原协同页，原协同页面的操作方式保留。不因 A 的改造删除或废弃这个入口。

**单文件协同特别处理**：S7 允许文件级 (`kind=file`) 和目录级 (`kind=directory`) Collaboration。打开单文件 Mount 应直接进入对应文件预览/属性及允许的文件操作，不能假造一个能无限下钻的文件夹。

### 5.2 Mount 仍必须是 Native 中的特殊叶节点

用户说“在原地展开”，指**浏览视图在同一界面切换**，不是指存储层将 Foreign 目录物化到 Native 目录表里。

```text
NativeNamespace（我 / partitionId / 不变的 scopeKey）
 ├─ NativeDirectory
 ├─ NativeLogicalFile ── Content Object
 └─ CollaborationMount {mountId,parentPath,name,collaborationId}
                            │ 每次重新解析授权
                            ▼
                 ForeignCollaborationNamespace
                 {ownerId, diskSpace, root, relativePath, role}
```

**不可变规则**：Mount 本体不含远端 Content refs；Native 的目录删除、目录统计、回收站、复刻、S3 Native tree traversal **遇到 Mount 必须停止**，不得自动递归到 Foreign。只有用户显式进入 Mounted view 或通过经过授权的只读 API，才遍历 Foreign 内容。

建议建立统一、可复用的服务端 `resolveMountedNamespace()`（命名不限），由真实登录者、所属本地分区、mountId、相对路径/远端资源 ID、访问渠道、操作类型解析出：当前挂载、现时 Collaboration、grantVersion、owner/scope、授权根与路径、role、能力集合。**严禁信任客户端提供的远端 ownerId + 原路径拼接**。

UI 建议使用显式状态：

```text
NativeView  = { kind: 'native', partitionId, path }
MountedView = { kind: 'mounted', partitionId, mountId,
                collaborationId, relativePath, optionalFileId }
```

- 面包屑要能返回本地 Mount 的父目录；支持刷新、分区切换、浏览历史、取消筛选、返回/前进。
- 同一个 Collaboration 可以通过两个不同 Mount 指向，分别保留本地入口，远端资源身份是同一个；不能因 Mount 名称或本地路径相同而串数据。
- 搜索、预览、浏览器缓存、文件选择集合必须带真实 namespace 标识，不得单纯按文件 `id` 或 UI path 缓存导致跨用户/分区错用。
- Foreign `viewer/editor` 与现有授权版本 `grantVersion` 继续适用。每次读/写、长任务提交前必须校验当前 membership/role/授权根/资源版本。
- 已被踢、退出、协同关闭或目标消失时：Native 本地仍可展示“已失效的挂载指针”，但 Foreign 的内容读取、派生公开分享/静态访问必须失效；Web 可移除本地失效 Mount。

### 5.3 Web 操作与来源归属矩阵

| Web 操作 | Mount **本体** | Mount **内部的文件/目录** |
|---|---|---|
| 打开 | 进入虚拟协同视图 | 目录继续浏览、文件直接预览 |
| 多选、排序、搜索 | 本地特殊节点行为 | 同 Native 体验，但按真实来源分组与校验 |
| 预览、下载 | 指针本身无二进制正文 | 读远端真实文件，支持原有 Range/分片/媒体类型 |
| 重命名 | 只改变我的 Mount `name` | editor 真正修改原所有者文件/目录名称 |
| 复制/移动 | 复制/移动**我自己的指针**（遵守禁嵌套） | 同协同内 Copy/Move；跨作用域见 §5.4 |
| 复制路径 | 返回带 Mount 上下文的可读虚拟路径 | 表示协同路径/来源，不能伪造普通 Native 绝对路径 |
| 属性 | 挂载名称、来源、授权状态等 | 显示实际类型、大小、来源 owner、权限等 |
| 缓存到浏览器 | 无二进制正文 | 按真实 owner/协同作用域缓存，防止同 fileId 跨账号碰撞 |
| 复制到协同项目 | 不是默认对指针递归复制 | 按 source read、target editor 的真实授权进行 Copy |
| 转发到隧道 | 不自动递归整个 Mount | 仅读取已授权资源并传给隧道功能 |
| 普通分享 | 可以在我的账号下分享受限 Mount 内容（须定义所选范围） | 默认允许对有权读的资源建立**我自己的**分享记录；见 §5.5 |
| 静态资源设置 | **仅此处可配置**；记录归我 | **不能单独配置**，只能复制按 Mount 记录派生的 URL |
| 复制静态链接 | 可复制该 Mount 对应的静态根 URL | 复制已开放 Mount 根令牌 + 相对路径派生 URL |
| 删除 | 「移除挂载」，**不删除对方任何资源** | editor 真实删除对方文件/目录，必须显著区分 |
| 防失联检测 | 不提供 | 不提供 |
| 邀请协同编辑 | 不提供二次创建 | 不提供二次创建 |

这里“像 Native 一样操作”指**交互复用**，不是把所有现有 Native API 处理器直接套用；涉及 ownership、Share/Static、目录递归、回收站、缓存键与锁的逻辑需要 Mounted-specific 分支。`viewer` 允许读、下载以及经确认的默认再次分享；变更 Foreign 真实文件必须 `editor`。

### 5.4 Copy / Move 真实语义与失败恢复

1. **同一协同授权根内部**：editor 能在不越界、不破坏协同根的情况下真正 `rename/move`；Copy 新建合规的 Logical 引用，支持 Content Object 复用。
2. **Foreign → 自己的任意指定 Native 分区和目录**：用户可选 **Copy** 或 **Move**。Move 允许实现为“先 Copy 完整成功并验证，再删除来源”。这是本轮明确新增的功能，不能继续沿用旧“跨 scope 一律只能 Copy”口径。
3. **Native → Foreign、Foreign A → Foreign B**：延续 S7 当前支持的授权 Copy；源 read、目标 editor。用户只明确开放了 Foreign→本人 Native 的跨 scope Move，不能自行推导其它所有方向都支持 Move。
4. **本人 Native 分区 A → 本人 Native 分区 B**：保留 S7 已经有的原生 Copy/Move 行为。

Foreign→Native Move 必须按**可恢复的多阶段操作**设计：

```text
PREPARE : 确认登录者/授权版本/源文件 IDs/目录树快照/目标分区和目录
COPY    : 以 Content lease + 新 Logical refs 完整建立目标目录和文件
VERIFY  : 确认复制结果已提交、目录/文件数和内容引用完整、可读取
DELETE  : 再次确认 editor、grantVersion、源版本/目录树未发生并发变化
          在原所有者 scope 删除源 Logical 文件/目录
DONE    : 仅在删源成功后显示「移动成功」
```

- **目标 Copy 失败**：不能删除任何源资源；回滚未提交的目标引用，遗留上传暂存通过现有清理流程处理。
- **目标 Copy 成功但源 Delete 失败**：明确报告 **部分完成（已复制，源仍保留）**，保留目标可查找；允许依据 operation ID 重试删源或做后续处理，不重复创建另一组同名目标。
- **源在 Copy 与 Delete 间发生修改**：不得凭旧快照删除已变化的新版源；校验 Logical 版本、内容版本、目录树成员清单和协同授权。发生冲突时停止删源并说明。
- **目录 Move**：绝不能把“逐个复制+逐个删除”伪装成原子目录移动，不能在目录新增/重命名/替换期间造成部分源丢失；建议锁定相关拓扑或采用可验证快照和幂等 Saga。
- **Content Object**：目标只是新增 Logical refs，不重传已经合法可复用的 Telegram 正文；删除源时只释放其 Logical refs，不触碰仍被目标引用的物理正文。

S7 `/cross-scope/copy` 当前仅支持 `mode=copy`，包含针对权限、Content lease、源版本与事务的保护，应在其基础上扩展受控 Web 流程，不要在前端两个不关联的 HTTP 请求中“复制接口一返回就盲删来源”。

### 5.5 默认允许再次分享：**分享记录属于挂载者**

最终要求：受邀者对**自己有读取权限**的协同文件或目录，默认可在本系统分享给别人；**无需原所有者另外授权**。未来支持更细粒度协同 ACL 时，才对配置了禁止分享的具体文件/目录执行限制。不要把先前讨论中建议的 `allowPublicReshare=false` 作为当前默认阻断。

设计应区分 Native Share 与 **Dynamic Foreign Share**。后者记录可用单独类型或扩展 `disk_shares`：

```text
shareOwnerId = 我（挂载者）
localPartitionId / localScopeKey
mountId / collaborationId
选择的远端文件 ID 或协同根内相对目录及范围
sharing token / createdAt / expiration / revokedAt
```

- 记录仅出现在**我**的网盘 Share 列表，不向原所有者的 `shares` 表增加属于他账号的分享记录；不复制整套文件或各个 Content Object。
- 匿名访问者使用的是经过范围约束的**分享访问令牌**，不是持有我的登录 Cookie 或 original grant。服务端每次请求按我的现时 membership/role、Mount 是否存在、原 owner 目标是否仍在授权根、review status、分享 token/有效期核验。
- 原所有者可继续移动、重命名、替换、删除源文件，不能因为我分享而被普通 Native Share 的“禁止修改/移动/删除”逻辑冻结。被删则分享失效；替换则在仍合法时返回当前内容；被移出授权根时失效。
- 为文件选择优先稳定 fileId，避免 rename 后链接错到其它同名文件。对于目录移动是否保留映射必须明确设计（稳定 ID / 更新定位 / 确认失效）；**不得把已移动目录的旧路径误指向别人后来创建的同名目录**。
- 协同踢人/关闭/退出、移除 Mount、文件撤销审查后，后续分享访问立即失败；已被客户端复制或缓存的内容无法收回，不作虚假承诺。
- Native 既有 Share 的保护和 token 语义保持不变。不要因开放 Foreign Share 而放松普通用户文件的保护规则。

### 5.6 仅在 Mount 本体设置静态资源开放

Mount 级静态开放是挂载者本地的一条记录，内部文件/目录的 URL **从挂载静态签名和相对路径派生**，不对每个 Foreign 项目另建静态记录。

```text
我的 Native / 🔗 协同项目 M1
    └─ Static grant T1（归我所有）
         ├─ docs/a.pdf  -> T1 + 安全编码的 docs/a.pdf
         └─ img/b.png   -> T1 + 安全编码的 img/b.png
```

- Web：`M1` 本体可开启/关闭开放、复制静态根 URL；进入 M1 后可复制内部某个文件/目录的派生 URL，但**不提供逐文件/目录的独立「静态资源设置」**。未开启或过期时应提示，而不是偷偷给内部项新建签名。
- 数据：`server/disk-static-resources.js` 当前仅支持 Native `file` / `directory`，可新增 `mount` type 或专属表。唯一归属是**挂载者账号+本地分区**，不能改变原所有者的 Static Resource 列表。
- 读时：签名/有效期/Mount 存在/当前 collaboration 授权/目标现时位置都需重新校验。**静态 token 只能授权该 Mount 范围内被公开的只读请求**，绝不能越过授权根或访问原所有者其它目录。
- 原所有者不用为了我的开放而停止 rename/move/delete。路径更名之后旧 URL 可能失效；不要无需求承诺永久稳定。
- HTTP 缓存须注明边界：服务器撤权后拒绝新的访问，但无法强制收回已发到浏览器/CDN 的缓存。
- 明确校验一次/二次 URL 解码、`%2F`、`..`、Unicode、斜杠结尾、目录前缀碰撞，防止签名绕过。

### 5.7 S3API 与 External 网盘 API：挂载全域强制只读

**最终业务规则**：Web 网盘中的 collaboration editor 可以编辑真实 Foreign 内容；**S3API 与 External API 中，不论调用者的协同 role 为 viewer 还是 editor，Mount 本体及其内部均只允许读。**

| 渠道 | Mount 本体 | Mount 内部文件/目录 |
|---|---|---|
| Web | 可以管理自己的 Mount 指针（重命名、移动、复制、移除等） | viewer 读/分享；editor 按授予范围写/删；Foreign→Native 可 Copy/Move |
| S3API | 以**虚拟目录前缀**显示、可以 LIST；不允许删除/改名/移动/覆盖/解除挂载 | 可 LIST/HEAD/GET/Range；禁止 PUT、覆盖、DELETE、多对象删除、以它为目标的 S3 Copy、其它写请求 |
| External 网盘 API | 可列出并读取挂载元信息及其授权目录；不能改动指针 | 可列表、属性、预览/下载/流；禁止新增/覆盖/修改/移动/删除/解除挂载 |

具体要求：

1. **只读投影，不在 Native 建目录**。`server/object-storage.js::list()` 当前只枚举原生 `adminFiles()` 与目录标记。S3 应把 Mount 映射成类似 `我的分区/张三项目/` 的虚拟 prefix，并为其目录/文件提供限定范围的 list/stat/open 解析。支持 ListObjects V1/V2、prefix/delimiter、分页、ContentLength、ETag、Range、HEAD/GET 等现有协议行为，不复制外国 Logical refs 到自己分区。
2. **必须拒绝每条写入通路**。对 Mount 根及任意后代前缀，至少覆盖 PutObject、Multipart Complete、DeleteObject、DeleteObjects、CopyObject 的**目的地**、目录 marker、批量操作、间接覆盖等；不能只是隐藏 GUI 删除按钮。能作为 CopyObject **读取源**并写入纯 Native 的情况未被用户专门要求，不必借此扩张 S3 功能范围。
3. **禁止“删除前缀 = 删除 Foreign”**。S3 的目录不是真实 Directory；客户端删除 `张三项目/` 可能先枚举 `张三项目/docs/a.pdf` 再逐一 DeleteObject。只拦截删除虚拟目录 marker 不够，必须拒绝所有 Mounted 后代的 DELETE。错误返回准确的 S3 `AccessDenied`/相应规范错误，不返回假成功。
4. **Native 父目录含 Mount**。如果第三方想把该父目录整体移走/清除，不能递归删除 Mount 或 Foreign。必要时拒绝“会包含 Mount 的递归性操作”并明确错误；Web 对本地父目录的历史删除/回收站语义仍按 Native 处理 Mount 指针，不进 Foreign。
5. **渠道级权限服务端鉴别**。S7 的 `contents(browser)` 与 `contents(external)` 存在共享资源路径。**Web 为 UI 实现写入用的同源接口不能被错误整体封掉**；S3/External 的限制应根据实际认证方式、操作渠道、source/target resolved namespace 决定，不让 API Token 利用另一个路径执行 Foreign 写入。
6. **真实授权并且无凭据提权**。S3 凭据只能识别 credential 所属挂载者账户和分区，代理读取依赖此挂载者现有 collaboration grant。S3 Access Key 不能直接变成原所有者的 Native Credential，不能访问超出 Mount 的目录。
7. **撤权后立即失效**。踢人、退出协同、原所有者关闭协同、Mount 移除、目标消失等，S3/External 下一次读取均被拒绝。不能靠缓存的 `remoteOwnerId` 或旧角色绕过。

### 5.8 必须保留的目录拓扑/数据安全不变量

服务端而不是 UI 必须保证：

- Mount 只能位于我自己的 Native Directory，不能建立在 Foreign 内部；Foreign 内不能再挂别人协同项目，也不能再次启用 Collaboration。
- 含有任意后代 Mount 的 Native 目录及其祖先不能被开启为 Collaboration root；已经开启的 Collaboration root 的任意后代不能创建或移入 Mount。
- 移动/重命名目录、移动 Mount、协同根及其祖先移动、回收站还原、跨分区复制等**操作完成后的结构**不能出现相互嵌套、自己套自己、别人套自己再套别人，也不能把已存在的 Mount 绕过校验带入协同子树。
- 同一 Native 父目录下文件、目录、Mount 不得同名；Native Foreign 边界不因为表面路径同名而混合；并发检查和提交必须保持一致。
- Native 的递归删除、大小统计、遍历、分区复刻遇 Mount 必须停止；只能读取/操作 Mount **本地指针**，不能递归污染/删除 Foreign 内容。
- 已失效 Mount 仍可在 Web 作为本地不可访问入口显示和移除，但不能继续打开外来文件；它在 S3/External 中也不能被当作可写节点。
- 源资源是否属于协同授权范围采用真实 owner+scope+root+relative path/文件 ID 校验；防止 `..`、重复 URL 解码、路径字符串前缀相似 (`abc` 与 `abcd`) 等绕过。

### 5.9 Web 删除 Foreign 内容：不要和“移除挂载”混淆

对 Mount 内 editor 点击「删除文件/目录」时，执行**真实原所有者 Logical Namespace 的删除**。UI 至少明确“此操作会改变协同所有者的真实文件”，且须检查授权根保护、review、并发/文件版本、原所有者已有 Static/Share 等保护。明确使用原所有者的真实文件删除/回收站机制；**不能错误地把被删 Foreign 文件放进我的 Native 回收站**，也不能借此删除 Mount 本体。移除 Mount 则只删除本地指针，不删除源文件。

## 6. 需求 6：系统文件管理器递归拖放文件夹上传 + 设置统一

### 6.1 已确认产品含义

- 在 Web 网盘的可上传 Native 目录中，允许从操作系统文件管理器拖入整个文件夹/多个文件夹。必须**递归读取全部文件和子目录**，保留拖入顶层目录名称与各级相对路径；空子目录也须保留（浏览器可读取的情况下）。
- **网盘允许最大目录深度：30 层**，统一适用于前端与服务端的目录创建、上传、复制/移动、回收站恢复及各入口；**不得残留 20 层硬封顶**。齿轮的个人设置应显示默认 30；若允许用户调整，有效值不能超过系统上限 30。用户未授权放宽到 31 层及以上。
- **上传文件夹最大尺寸：默认 500MB，且允许修改**。只指**本次拖进来的所有文件夹（含全部子层级）内的常规文件之和**；不是目标网盘文件夹中所有已保存文件的大小，也不取代单文件上传原本的限制。
- 早期“上传前固定不能超过 300MB”的需求已被最后修正**明确替换**，不要两套限制并存。

> 实施时须固定 UI 的「MB」换算单位（十进制/二进制）并让前后端一致，写测试证明精确边界。用户没要求新增较低的隐式硬阈值。

### 6.2 现有代码限制及需要改动的地方

1. `server/telegram-drive.js::assertDepth()` 当前有 `Math.max(1, Math.min(20, Number(maxDepth) || 20))`，**实际服务端仍限制 20 层**。统一上限 30 不能只改 UI，必须追查所有注入 `maxDepth()` 的调用和另外的路径 normalize/depth 校验。
2. `client/disk-client.js::uploadFiles()` 单批 100 文件检查仍在。一个 800 文件、200MB 的文件夹不能让用户手工分八次上传，应在递归目录任务中按合法批次调度，而不是简单粗暴取消已有批次防护。
3. `client/disk-ui.js::installDiskDrop()` 当前通过 `DataTransfer.files` 获取拖入文件，`confirmLocalDiskUpload()` 直接调用普通文件上传，不会完整保留系统目录多层级。应增加真正的文件夹枚举和多级目录创建，不能把目录内文件扁平化上传到同一个目录。
4. `server/disk-partitions.js::updateSettings()` 当前只接受 `{version:1}`，没有用户可编辑的这两个配置项。要求是**个人网盘全局设置**，不是当前分区设置，不能把设置仅写入当前 partition 导致切换分区后失效。可新增 user settings 或复用现有 owner-scoped 配置实体。
5. `server/disk-api.js` 的不同操作及 `server/object-storage.js` 都会触达目录深度；须逐条排查 Native/协同 editor/S3 Native/External API/跨分区转移/回收站恢复，统一有效规则。**S3/External 对 Mount 写入仍然禁止，与深度设置没有冲突。**

### 6.3 完整上传工作流

1. **读取本地目录树**：根据浏览器能力使用 `DataTransferItem.getAsFileSystemHandle()`、`webkitGetAsEntry()` 等可用机制，`readEntries()` 循环直至返回空；支持拖多个根目录。勿把整个 500MB 在浏览器内一次性读进内存。无法访问某目录/文件时明确告知，不得悄悄漏上传还提示成功。
2. **计算最终目录层级**：`目标目录层级 + 拖入根目录和最深后代目录层级`；例如目标 `A/B/C` 深 3，拖入 `Photos/2026/JP` 深 3，最终 6 层；30 层允许、31 层拒绝。校验非法名称、过长路径、重名、Mount 名称冲突、路径穿越。检查目录深度不应把文件名算成新一级目录。
3. **预检文件夹体积**：所有源文件大小 `sum(file.size)`，同一次拖入多文件夹合并计算；超过用户设置上限则整体拒绝，恰好达到上限允许。预检对话框列出目录数、文件数、合计大小、目标路径、潜在冲突。
4. **先构造目录，再传文件**：用已有 Native 创建目录逻辑创建缺失父路径与空目录；自动把大量文件按合法 API 批次上传。尽可能复用 S7 现有 Progressive Upload、Content Object 去重、分片、速率/队列、取消、恢复和防重名机制。
5. **服务端权威校验**：前端只做快速预检；服务端必须独立重新验证目标路径合法、实际有效层数与权限。限制 `folder upload max size` 的实现须能约束一次多批文件夹任务的**整体输入**，不能被拆成多个小批来规避总上限（例如持久化 manifest/任务总计及关联批次）。如果某个浏览器无法完整枚举，则提供说明或可行的文件夹选择替代，不要假成功。
6. **进度与部分失败**：展示整个文件夹任务的完成字节/文件数/当前路径；中断、取消、客户端断线、后台任务失败后明确哪些内容已成功、哪些未完成，能够安全重试或清理；禁止静默重复文件或宣称“已完成”而遗漏空目录。
7. **明确 Native 与 Foreign 的上传目的地**：普通文件夹拖放不能误用 Native URL 上传到 Mount 路径。Web editor 未来对可写 Foreign 目录上传时，应显式走协同授权 API，并遵守相同合法层级与目录禁止嵌套规则。

### 6.4 全局设置的数据与 UI

建议设置内容包含：

```text
UserDiskSettings {
  ownerId,
  version,
  maxFolderUploadBytes,   // 默认 500MB，经统一单位换算
  maxDirectoryDepth,      // 默认 30，绝对不得超过 30
  updatedAt
}
```

字段名与存储方式 Codex 可调整，不必机械增加新表；必须做到：

- 齿轮的「个人网盘全局设置」中可见、修改、持久化，刷新/跨设备后仍生效，切换分区不会更换这两项。
- 旧用户没有记录时有一致默认值，服务端验证修改值的类型/合法区间/版本，防止任意 JSON 或负数被注入。
- 如果用户把可配置深度从 30 下调到更小值，已存在较深目录**不能被自动删除或隐藏**，应仅限制以后会增加违规层级的操作；只读访问旧目录仍能工作。
- 500MB 只用于**文件夹拖放输入总量限制**，不得误加为单文件 500MB 限制或当前目录配额。

## 7. 需求 7：新建纯文本、Markdown、十六进制文件与写时复制

### 7.1 用户界面

网盘增加 `新建文件 → 纯文本 | Markdown | 十六进制`：

- **纯文本**：可输入、保存/取消/重开，默认 UTF-8，保留换行内容并妥善提示编码错误/未保存修改。
- **Markdown**：双栏，一边 Markdown 文本编辑，另一边安全的实时渲染预览；窄屏可以用分栏切换、上下布局等自适应方式，但必须保有“编辑+预览”能力。
- **十六进制**：双栏，一侧按偏移编辑真实 byte hex 数据，另一侧预览实际字节（ASCII/UTF-8 可读字符或相应二进制可视化）。**不能直接用普通文本编码去替代二进制字节**；校验合法十六进制、字节长度、超长内容和无效输入。
- 遵守文件名/扩展名/MIME、Native 同名冲突、目录层级、用户权限和当前分区。为 Web 大文件编辑设置合理且明确的内存/大小保护，不影响原有超大文件**下载**能力。
- 新建至少完整支持 Native 文件夹。若界面也允许在 Foreign Mounted view 的 editor 创建/编辑文件，必须以该协同项目原所有者的 Logical namespace 保存，按 role 校验，不得意外保存进挂载者自己的分区。
- Markdown 渲染必须清理不可信 HTML/链接/script/事件属性，避免 XSS；预览框中应限制主动脚本和不可靠远程资源。

### 7.2 **Content Object 的不可变安全底线**

用户特别强调：**既然允许编辑文件，就不能继续把新内容写在原本的共享 Content Object 上；应创建新的 Content Object 再关联到当前 Logical File。**

推荐按 Copy-on-Write 设计：

```text
原 Logical File F ──ref──> ContentObject C1（还被其它文件引用）
       │ 编辑生成新正文 bytes
       ▼
创建并校验 ContentObject C2（新内容；不可修改 C1）
       ▼ 版本/CAS/权限校验 + 原子切换
Logical File F ──ref──> C2
其它 Logical File ──ref──> C1（旧正文完全不变）
```

实现要点：

1. 保存前取得当前 Logical File 的 `contentId/contentVersion/revision`、真正 owner/scope、读写权限；保存时再校验文件未被并发替换、删除、撤权、review 封锁。
2. 对编辑后的内容走可核验字节 hash/长度、正确 Content 创建或等价独立的不可变内容实例流程；**绝不原地改写 C1 的物理正文或其它共用引用**。
3. 新内容先可靠写入/校验，再通过 SQLite transaction / CAS 仅将目标 Logical File 的引用更新到 C2；保持目标 Logical File ID/适用的 metadata 与正确更新时间。
4. 只在引用成功切换后才释放旧 ref，旧 Content Object 的清理必须服从现有 refcount、leases、延迟 cleanup 和外部 Telegram 锚点机制。保存失败不得污染旧正文；孤儿新物理内容按现有清理机制处理。
5. 内容没变化时不做无意义的高成本写入。若现有去重优化返回物理相同内容，也仍需保证将来对其中任意一份的编辑都不会影响其它 Logical 的字节；不能误解为“直接修改共享 Content”。
6. **普通编辑保存 != 防失联检测/修复**。不应不经审查直接把 `files/:id/repair` 当作普通编辑接口，避免覆盖、元数据、清理和权限语义混淆；可以复用底层上传/Content 验证组件，但新增合规的编辑事务语义。

### 7.3 并发冲突与测试

- 两个 Web 标签页同时编辑、另一个协同 editor 改内容、原所有者移动/删除、写入进行中 grant 被撤销、网络/Telegram 写失败：应拒绝覆盖不再匹配的版本，不静默以最后写入胜出。
- 如果编辑的是 Foreign 内容，新内容切换发生在**原 owner 的 Logical File 上**，不是“复制到自己网盘”；Share/Static 对内容变化的动态行为应与 §5 一致。
- 验证纯文本中文/emoji/CRLF/LF、Markdown 注入 HTML、hex `00 7F 80 FF`、空文件、超出编辑器容量、多次保存和取消。
- 关键回归：两份 Logical File 原先共享 C1，编辑其中一份后另一份仍读出**完全相同的旧字节**；编辑的文件读出新字节，删除/还原/Content cleanup 后引用没有断裂。

## 8. 服务端操作分类、访问渠道与统一权限矩阵

| 操作 | 自己 Native Web | Mount 内 Web viewer | Mount 内 Web editor | Mount 内 S3API / External API |
|---|---|---|---|---|
| 列表、搜索、属性、预览、下载 | 按现有规则 | **允许** | **允许** | **只读允许** |
| 新建/上传/重命名/替换/删除 Foreign | 不适用 | **禁止** | **在授权根内允许** | **禁止** |
| 同一协同内 Move | 不适用 | **禁止** | **在授权根内允许** | **禁止** |
| Foreign → 我的 Native Copy | 目标须本人可写 | 源可读、可 Copy | 源可读、可 Copy | 本轮不额外开放外部改动入口 |
| Foreign → 我的 Native Move | 不适用 | **禁止** | **按安全两阶段流程允许** | **禁止** |
| Native → Foreign / Foreign A → B Copy | 源 read / 目标 editor | 单凭 viewer 不获得目标写能力 | 授权满足时允许 | 对挂载目标**禁止写** |
| 普通分享 Foreign | 我自己的分享记录 | **默认允许** | **默认允许** | 不通过外部渠道新建代理分享 |
| Mount 级静态开放 | 在我自己的 Web 设置 | Foreign 内不能单独设置 | Foreign 内不能单独设置 | 不可新建或修改开放配置 |
| Mount 本体 rename/move/移除 | 我自己的指针可管理 | 不适用 | 不适用 | **禁止** |
| 再次邀请协同/嵌套 Mount | 受 Native 拓扑规则约束 | **禁止** | **禁止** | **禁止** |

**重要**：第三方 API 的“只读”只针对**挂载指针及其 Foreign 子树**，不意味着用户自己的普通 Native 分区全部只读。任何操作都应先 resolve source/destination namespace 和认证渠道再判定能力，不能靠“请求方法是 GET 就安全，POST 就危险”的单一规则：有些 POST 是读取准备，有些 GET/代理 token 泄露敏感信息，有些 Native Copy 会引入写入目标 scope。

### 8.1 必须防止的身份提升

- `collaboration-scope` 内代码可能暂时将 `req.diskUser` 设为原 owner 以复用存储逻辑；这**不是**真正将 viewer/actor 登录身份切换成 owner。读写审计、任务归属、Share/Static 创建者、外部签名权限必须仍使用真实 actor/挂载者身份。
- `mountId` 不是能力令牌，知道 Mount ID 不代表有权读取；所有请求必须核实 actor 仍为该 Mount 的所属账号并被原 owner 授权。
- 同一个 collaboration 被挂载在多个位置，任何来自不同 Mount 的 path/fileId 访问都要重新检查当前来源，而不是用缓存“第一次授权成功”放行后续请求。
- 普通文件 `fileId` 在不同 scope 可能冲突；异步任务和浏览器缓存的键必须加入 scope 和足够的身份信息。
- 分享/静态 URL 的匿名访问不意味着读取者继承所有 editor 权限；令牌只授权已公开部分的只读 GET/HEAD。

## 9. 数据安全、并发与不变量（需要服务端断言/测试）

**命名空间拓扑**：

- `Mount` 是 Native leaf；`Mount` 不能进另一个 Mount，不能放在已协同目录的子树中；含 Mount 的 Native 目录不能开启协同；移动后的拓扑仍合法。
- Mount、Native 目录、Native 文件共享同一父目录名称空间，不得同名。前端预检 + 服务端最终事务检查均需要。
- `sourceScope == targetScope` 不足以自动认定同一 collaboration；需核对 grant root 和 actor；相反跨 scope 也不能自动认为允许写入。
- Native 递归删除/复刻/统计/回收站只作用于原生资源和本地 Mount 指针，不得进入 Foreign。

**生命周期**：

- 原 owner 授权撤销、角色改变、文件删除、原 owner 分区注销时，Mounted 浏览、Share/Static 派生读取、S3API/External 只读访问均必须在下一请求重新授权；前端的缓存导航不能成为权威。
- 长时间上传/复制/移动/生成新 Content 时至少起始和提交点再校验 actor、role、grantVersion、资源版本与目标分区状态。
- 不能把同步 SQLite transaction 包住 Telegram 网络 I/O 误当真正的端到端原子事务。外部 I/O 前后须有可恢复状态与正确的 Logical commit 顺序。
- 删除源 Logical File 之前必须确认目标 Content refs 已持久存在。任何 ContentObject cleanup 都应按引用与租约进行，而不是按源目录逐层把底层 Telegram 正文删除。

**公开访问**：

- 分享/静态派生链接始终只授予 Mount 范围内资源，禁止通过 URL 编码、路径拼接或删除重建同名目录继续引用错误目标。
- Public Share 读是**外部匿名请求**，不能把整个协同 grant 直接返回客户端；只投影所分享范围的文件与目录。
- Cache-control / CDN 的不可撤销缓存风险应有明确处理边界，不因用户要求“撤权失效”而假装可以清除第三方浏览器已存副本。

## 10. 推荐实施阶段（可调整顺序，但不能遗漏范围和验收）

1. **梳理实际工作区**：确认分支、HEAD、已有修改与测试基线；保护不属于本轮的未提交代码。
2. **先处理简单可验收项**：回收站真实资料（1）、协同列表固定关闭按钮（2）、网页工坊导入 Loading（3）；提交最小测试并验证无旧功能回归。
3. **Mounted Namespace 底层和 UI 导航**：服务端 resolve、客户端 MountedView 状态、面包屑、读/属性/预览/下载/多选。仍保留顶栏协同列表旧全屏页面。
4. **Mounted editor 操作及跨 scope 移动**：依次完成 rename、协同范围内 Copy/Move、到指定原生分区 Copy，最后做 Foreign→Native 的可恢复 Move。验证“复制成功但删源失败”安全。
5. **代理 Share / Mount Static**：先建立 owner/授权/签名数据模型及服务端匿名读取测试，再接 Web UI；不能冻结原 owner 文件。
6. **S3API / External 挂载只读投影**：完成 LIST/GET/HEAD/Range；全覆盖写入/删除的服务端拒绝，尤其批量删除、父级目录和 COPY 目标。
7. **30 层和 500MB 设置 + 拖入目录上传**：统一原生路径上限、个人全局设置、浏览器递归读取/分批上传/整体进度和失败处理。
8. **文本/Markdown/Hex 编辑**：编辑器 UI、服务器 Content Copy-on-Write、版本 CAS、旧 refs 兼容与 XSS 测试。
9. **回归与故障注入**：全套身份、跨分区、回收站、静态分享、Content cleanup、S3/External、安全、响应式 UI 与迁移测试。

## 11. 必备验收案例（可增加，不可只做 happy path）

### 11.1 项目 1～3

- 删除 `新建 Microsoft Word 文档.docx` 后，回收站展示真实名称、类型、总大小、完整原路径、删除时间；恢复后原文件内容完好；不能显示 `:recycle:<id>`。
- 各种文件、嵌套/空目录、旧脏条目、跨分区/同名还原均有正确展示和错误处理。
- 100+ 条「查看协同列表」项滚动时，右上 `×` 与右下「关闭」都固定且可点击；PC/窄屏/软键盘适配；旧协同 iframe 行为未变。
- 网页工坊选 1 个、多文件、目录源导入：开始立即 Loading，下载过程中转圈，结束/失败/取消立即复位，不能重复提交或永久转圈。

### 11.2 Mounted 浏览与核心权限

- A 原 owner、B 受邀：B 在本地不同目录挂同一协同项目两次；能分别原地进入、返回原本地父目录、刷新/切换分区；所见内容来自 A 的真实目录；不复制正文或 Native Logical 元数据。
- 文件级 grant 作为 Mount 能预览单文件，不开放不存在的子目录树。
- B viewer：下载/普通分享可用，真实 rename/replace/mkdir/delete 必须拒绝。改 editor 后 Web 允许对应操作；移除 membership 或设回 viewer 后正在运行的写操作不得继续提交。
- 协同文件改名后 A Native 真正看到改名；重命名 B 的 Mount 只改变 B 指针名称；A 的 Share/Static 列表仍不含 B 的公开记录。
- 同名文件/目录/Mount 冲突、路径 `abc` 与 `abcd` 前缀碰撞、Unicode、`../`、重复编码斜杠、超出 grant 目标、其它 owner fileId 都拒绝越权。
- 含 Mount 的 Native 目录开启 Collaboration、协同子树移入 Mount、Mount 内二次协同、把 Foreign 目录移动成其祖先等非法拓扑都拒绝；Native 删除父目录不删 Foreign。

### 11.3 Foreign→Native Move 故障注入

- Copy 成功时目的文件 Content refs 可正常读取；源还在时不可显示「移动完成」。
- 复制失败、网络中断、目标重名、目录深度违规、目标分区正在删除、源 grant 被撤销、文件版本变化、目录树新增文件、删源失败：没有任何来源被提前删除，不污染其它 Logical 的 Content refs。
- Copy 完成/源删除失败：用户看到“已复制、源仍保留”，重试能够识别目标和操作 ID，避免重复新建内容。
- 本人 Native A/B 跨分区 Copy/Move 原行为正常；Foreign A→B 仍限授权 Copy，没有被无故升级为 Move。

### 11.4 分享、静态资源、S3/External

- B 分享 A 的文件/目录：仅 B 的 Share 列表有记录；A 文件 rename/move/delete 不受冻结；分享 token 不能浏览超出范围的其它文件；B 被踢则匿名后续请求拒绝。
- B 对 Mount 本体建立一条 Static 记录：内部文件/子目录只有派生 URL，无独立静态配置记录。B 撤销、移除 Mount、失去协同授权时访问失效；原 owner 的配置不发生变化。
- S3 在 B 自己的 bucket 中能够看到 Mount 虚拟前缀和内部文件，LIST/HEAD/GET/Range 正确；`PUT`、`DELETE`、`DeleteObjects`、Copy 到 Mount、删除 Mount 父目录企图隐式清理 Mount 均拒绝且绝不触及 A 文件。B 的普通 Native S3 操作正常。
- External API 同样只读；不能经带文件 ID 的独立 endpoint、批处理或另一个路径绕过；Web editor 仍可正常修改。

### 11.5 文件夹递归上传与编辑

- 30 层恰好允许、31 层被**服务端**拒绝；任何分区下都遵守统一设置；从旧目录复制/移动和回收站恢复也受正确限制且不损坏历史文件。
- 多个文件夹合计刚好 500MB（按统一单位）允许，超过拒绝；目标分区已有其它大文件不影响本次文件夹大小判断；没有旧 300MB 阈值。
- 浏览器拖入包含空目录、数百上千文件、同名文件位于不同子目录、中文目录名的目录树，能自动分批上传完整结构并显示正确进度；部分失败不会假报全量完成。
- 纯文本中文/emoji/换行、Markdown 安全预览、十六进制 `00 7F 80 FF` 保存/重开字节完全一致；含恶意 HTML 的 Markdown 不执行脚本。
- 两个 Logical File 共用 C1；编辑 F1 后，F2 依旧读出 C1 的全部旧字节，F1 读出新 ContentObject C2；冲突/网络失败时旧数据完好且无不可收拾的 orphan refs。

建议复用或扩展现有测试：`tests/disk-collaboration-mounts.test.cjs`、`tests/disk-native-mount-ui.test.cjs`、`tests/disk-mount-ui.test.cjs`、`tests/disk-cross-scope-copy.test.cjs`、`tests/disk-collaboration-navigation.test.cjs`、`tests/disk-partitions.test.cjs`、`tests/disk-api.test.cjs`、`tests/disk-sharing.test.cjs`、`tests/disk-static-resources.test.cjs`、`tests/disk-content.test.cjs`、`tests/disk-storage-regression.test.cjs`。对回收站、导入按钮、目录递归上传、Mounted S3/External 只读和编辑另补专项测试。

## 12. 禁止的误实现清单

1. **不准**把 Mount 在 Native 里持久化成普通目录，或为其 Foreign 子孙文件创建成本地 Logical refs；只能在显式复制时新增目标 Logical refs。
2. **不准**把原地浏览简化为“继续打开 iframe，只是变小”；顶部「查看协同列表」旧全屏页面反而必须保留。
3. **不准**在后台将挂载者的 share/static 记录写进原 owner 账号，或将被挂载者的文件因此锁死。
4. **不准**默认阻止 viewer 对已授权可读 Foreign 内容再次分享；未来细粒度 ACL 未实际设置的情况下默认允许。
5. **不准**将 Web 的 editor 权限扩展给 S3/External 对 Mount 的写操作；**禁止所有形式的 Mount 指针移除和子树写删**。
6. **不准**将“移除 Mount”解释为递归删除 Foreign 内容，或 Native 删除祖先误入 Foreign 子树。
7. **不准**在跨协同 Move 的 Copy 未完整确认前删除源；删源失败不得称移动成功。
8. **不准**在编辑后原地改写共享旧 Content Object 物理内容、让其它 Logical 同时变化。
9. **不准**继续保留 20 层服务端上限和已被撤销的固定 300MB 阈值；500MB 只对本次拖放文件夹文件总量生效。
10. **不准**只隐藏按钮而不在服务端校验 owner、actor、scope、grant、role 与操作渠道。
11. **不准**顺手开发原编号 5「指定目录全量下载 ZIP」——明确暂缓。

## 13. 最终交付及开发记录

Codex 完工后必须提供：

1. **基线与 Git**：工作分支/HEAD/原有差异和未跟踪文件的保护情况；最终 Git 状态。
2. **逐项覆盖**：按照原编号 1、2、3、4、6、7 列出完成/部分/未完成、对应变更文件与验收依据；编号 5 标为暂缓未实施。
3. **架构说明**：Mounted namespace 解析、Web 原地 UI、两阶段 Move 失败恢复、本地 Foreign Share、Mount Static、S3/External 只读门禁、全局上传设置和 Content Copy-on-Write 的具体落地方式。
4. **变通说明**：与本文推荐实现不同但能满足已确认产品语义的选择及原因；不得跳过有难度的权限边界。
5. **真实测试结果**：执行的命令、通过/失败/跳过数量及失败原因；未能在当前环境验证的内容明确列明，不得声称完成验收。
6. **风险与迁移**：数据表/schema、历史 Trash/Share/Static/Content/协同数据兼容性、并发与授权撤销的残余风险。
7. **开发记录**：优先续写 `docs/devlog/dev-2610-features.md` 本轮章节（如外层任务另有明确位置，则遵从外层要求），不得覆盖旧记录；Git 提交建议仅在用户明确要求时附上，不擅自提交。

---

**最后原则**：让挂载的 Foreign 项目在**同一套 Native 网盘 UI**中获得一致而便利的交互，并不意味着在后端混同所有权。任何路径、操作、Token、公开链接和 Content 引用，都必须能明确证明：**谁在操作、资源归谁、授权来自哪里、正在通过什么渠道、会真正修改哪一个 namespace。**
