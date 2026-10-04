# 网盘共享 Content Object 结构迁移

工具：`tools/migrate-tgdisk-content-objects.cjs`。需要与服务相同的 Node 内置 SQLite 运行环境（项目要求 Node 24.15+）。只操作指定数据目录的现有 `disk.sqlite`；不读取/发送 Telegram 消息，不推断整文件 SHA，不改 Logical ID、用户、目录、Share 或协同关系。

## 执行顺序

1. 等待本站正在执行的上传、移动、转码等任务结束；停止使用该数据目录的全部本站 Node 进程，并暂停进程管理器的自动重启。
2. 备份完整 `.tunnel-data`，尤其是 `disk.sqlite*` 和密钥。只有旧 JSON 的环境，先运行并核对 `tools/migrate-tgdisk-json-to-sqlite.cjs` 的预演和导入；本工具不会凭空创建空数据库。
3. 在项目根目录预演；目录也可使用绝对路径：

   ```powershell
   node tools/migrate-tgdisk-content-objects.cjs --data-dir .tunnel-data
   ```

4. 核对文件数、分区和绑定情况，再执行：

   ```powershell
   node tools/migrate-tgdisk-content-objects.cjs --data-dir .tunnel-data --apply --service-stopped
   ```

`--service-stopped` 是管理员停服确认，不会帮你终止进程。未停服不要传此参数。工具先用只读连接检查 SQLite 完整性/外键，再使用内置备份 API 创建 `migration-backups/content-objects-<时间>-<UUID>.sqlite`；备份成功后才打开新版 repository 执行结构包装事务。数据目录参数优先于 `TUNNEL_DATA_DIR`，两者都没有时为当前目录下的 `.tunnel-data`。

## 报告字段

| 字段 | 含义 |
|---|---|
| `schemaVersion` / `migrationRequired` | 当前 SQLite schema 版本；预演中版本低于 v2 或仍有未绑定的非删除 Logical 时需要迁移 |
| `logicalFiles` / `tombstones` | 全用户全分区的逻辑记录和删除审核记录 |
| `bindings` / `unbound` | 有效引用和仍需包装的非删除 Logical |
| `contents` / `anchors` | 内容对象和记录的物理消息数量，不是上传次数 |
| `hashStates` / `canonicalKeys` | 已验证内容、历史未验证内容、异常及 hash 命中入口数 |
| `states` / `cleanup` | Content 生命周期和待清理/已清理债务 |
| `conflicts` | 部分重叠物理 Anchor 的 Content IDs，自动 GC 已隔离 |
| `quarantinedHistory` | 缺少可靠物理位置/内容证明的旧 fileIdHistory |
| `referenceMismatches` | Logical 投影字段与权威引用不一致数量，应为 0 |
| `unresolvedPublicRevisions` | 仍以 public 名称/链接定位的物理 revision，需要确认 Chat ID |
| `scopes` | 各分区的 Logical 数量 |
| `relatedRecords` | 原有目录、分享、协同记录数量，用来核对迁移没有遗漏外围关系；本工具不重写它们 |
| `physicalWarningCount` / `physicalWarnings` | 未清理 revision 的物理投影异常总数及最多 200 条样本；样本带 Content ID、revision 与原因，不等于被自动修复的数量 |

物理异常原因包括分片 offset/大小布局异常（`invalid-part-layout`）、缺少 file ID/消息位置（`missing-part-location`）、总分片大小与文件不符（`incomplete-size`）、未解析的数字 Chat（`unresolved-chat`）、找不到配置中的后端（`unknown-backend`）。`physicalWarningCount` 可能超过报告中的 200 条样本，必须以总数判断问题范围。工具不会根据这些告警猜测或改写物理消息位置。

迁移不假定同名、同大小、相同 file_id 或分片哈希相同即完整内容相同。完全相同的物理集合可以保留为一个历史表示；部分重叠禁止自动删除。出现 conflicts、物理异常或未解析 public 定位时，保留备份和报告，核对数据；不要为了消除告警随意删除 Anchor、改 Chat 或清空库。

包装后的 `legacy_unverified` 仍可读取；`canonicalKeys: 0` 可以是正常结果，不表示文件丢失。管理员可按 [Content 管理说明](../docs/telegram-drive-content-objects.md#7-历史数据与运维) 明确请求完整内容验证和可选合并。该操作可能产生大量回源流量，不属于本脚本的自动流程。

## 成功、重跑和回退

- 预演先核对 `migrationRequired`、`schemaVersion`、`relatedRecords` 和物理告警；即使预演显示无需迁移，也不要把告警理解为已经修复。
- `--apply` 后检查 `after.unbound: 0`、`after.referenceMismatches: 0`，核对 Logical 数量、分区、外围关系、history/冲突和备份路径。
- 重复执行不会增加相同绑定或重新发送消息；每次 apply 都另存备份。预演只读，不执行 schema 初始化或创建缺失数据库。
- 启动新版服务，抽查列表、原文件、Range、分享、协同、S3 及删除后的引用保护，再开放正常写入。
- 失败时不要继续启旧版写同一个 v2 数据库。保持停服，核对错误和备份；需要回退时恢复一致性备份及对应版本，同时考虑迁移之后新增的数据和远端变更。
- 不保证损坏数据库、权限错误、磁盘满等环境问题“绝不出错”；工具以拒绝猜测、写前备份、事务回滚和明确报告保护数据。
