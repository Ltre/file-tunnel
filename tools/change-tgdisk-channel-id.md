# 网盘文件托管频道 chat ID 离线迁移

适用于同一 Telegram 频道从公开 `@username` 改为私有数字 `chat_id` 的情况。脚本修改 SQLite 文件记录的 `channelId`（包括待清理旧消息的频道引用），不改文件、分片 ID、消息 ID、Bot 凭据或 Telegram 消息 caption。所有分区、所有用户的文件均会处理。

共享 Content schema v2 中，工具改为更新 Content 的物理 revisions、Anchor 身份、分片绑定和清理/待补 caption 定位，同一事务处理所有引用。Logical payload 不重新保存物理频道。把多个不同 Chat 中的相同 message_id 合并到一个目标会报冲突，不会猜测消息归属；只能用于同一个真实频道的标识变更，不能用于搬迁消息到另一个频道。运行命令及停服备份要求不变。

1. 在 Telegram 中取得**同一个频道**的真实数字 `chat_id`（通常以 `-100` 开头）。不同频道的消息 ID 不能直接迁移；若是新建频道，不能使用本脚本。
2. **停止所有连接该数据目录的 Node 服务和后台任务**，确保没有写入进程。先备份整个 `.tunnel-data` 目录。
3. 预演并核对旧频道分布和修改数量：

   ```powershell
   node tools/change-tgdisk-channel-id.cjs --data-dir .tunnel-data --chat-id -1001234567890
   ```

   预演以 SQLite **只读连接**执行，不修改数据库，也不会创建缺失的数据库。`--data-dir` 必须是实际运行服务使用的数据目录；显式参数优先于 `TUNNEL_DATA_DIR` 环境变量。两者均未提供时，本工具继续默认使用**当前执行目录**下的 `.tunnel-data`，而服务器默认使用**项目代码目录**下的 `.tunnel-data`，因此建议在项目根目录运行，或始终指定绝对路径。参数没有提供值时会直接报错。

4. 核对后执行（`--service-stopped` 表示你已停服；没有它脚本拒绝写入）：

   ```powershell
   node tools/change-tgdisk-channel-id.cjs --data-dir .tunnel-data --chat-id -1001234567890 --service-stopped --apply
   ```

脚本在写入前使用 SQLite 在线备份 API 创建 `.tunnel-data/migration-backups/channel-id-*.sqlite`，然后在单个事务内更新文件，并逐条核对并发变化。失败时事务回滚。重复执行同一目标 ID 会显示 `changed: 0`。迁移后还要在后台把网盘托管频道配置改为同一个私有 chat ID；如果文件使用了独立 `backendId`，也要核对对应存储后端仍指向该频道。随后再启动服务并抽查文件列表、缩略图、Range 下载和删除。原有 Telegram caption 中的历史 `channel:` 文字不会自动编辑。

## 输出 `totalFiles: 0` 时

`totalFiles` 是指定 `disk.sqlite` 的 `disk_files` 表中**所有用户、所有分区**的文件数量，不是当前目录的文件数量。本脚本不读取旧 JSON 作为迁移目标，也不会自动执行 JSON → SQLite 导入；新版服务首次启动可以创建空库，旧 JSON 仍需要单独导入。

当 SQLite 文件表为空时，工具会额外只读检查默认索引 `telegram-drive-index.json` 和 `disk-spaces/*/telegram-drive-index.json`，输出 `legacyIndexes`、`legacyTotalFiles`、`status` 和提示：

- `legacy-json-not-imported`：发现非空旧索引，`migrationRequired: true`。这可能是旧数据尚未导入，也可能选错了数据目录，不能视为已经修改频道。
- `legacy-inspection-incomplete`：旧索引损坏、不可读或不是普通文件等，无法确认旧数据；先修复提示中的文件/目录问题。
- `empty`：未发现非空旧索引，显示“无需修改”；如果你认为应当有文件，仍应核对实际运行服务的数据目录。

前两种情况执行 `--apply` 会拒绝操作，以 `mode: blocked` 输出检查报告，并以非零退出码结束，不会创建迁移备份或改写旧 JSON。缺少 `disk-spaces.json` 时仍会发现实际存在的命名分区索引，但不会猜测分区名称。SQLite 已有文件时不会因导入后仍保留旧 JSON 而阻止正常频道迁移。

如确认是旧数据尚未导入，在**停服状态**下，使用同一个正确数据目录依次执行：

```powershell
node tools/migrate-tgdisk-json-to-sqlite.cjs --data-dir .tunnel-data
node tools/migrate-tgdisk-json-to-sqlite.cjs --data-dir .tunnel-data --apply
node tools/change-tgdisk-channel-id.cjs --data-dir .tunnel-data --chat-id -1001234567890
```

先核对 JSON 导入预检结果，再决定执行导入。确认最后的频道预演文件数量正确后，才执行本工具的 `--service-stopped --apply`。如果命名分区清单缺失或无法映射，JSON 导入工具会拒绝猜测，请先恢复正确的 `disk-spaces.json`。
