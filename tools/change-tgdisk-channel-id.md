# 网盘文件托管频道 chat ID 离线迁移

适用于同一 Telegram 频道从公开 `@username` 改为私有数字 `chat_id` 的情况。脚本修改 SQLite 文件记录的 `channelId`（包括待清理旧消息的频道引用），不改文件、分片 ID、消息 ID、Bot 凭据或 Telegram 消息 caption。所有分区、所有用户的文件均会处理。

1. 在 Telegram 中取得**同一个频道**的真实数字 `chat_id`（通常以 `-100` 开头）。不同频道的消息 ID 不能直接迁移；若是新建频道，不能使用本脚本。
2. **停止所有连接该数据目录的 Node 服务和后台任务**，确保没有写入进程。先备份整个 `.tunnel-data` 目录。
3. 预演并核对旧频道分布和修改数量：

   ```powershell
   node tools/change-tgdisk-channel-id.cjs --data-dir .tunnel-data --chat-id -1001234567890
   ```

4. 核对后执行（`--service-stopped` 表示你已停服；没有它脚本拒绝写入）：

   ```powershell
   node tools/change-tgdisk-channel-id.cjs --data-dir .tunnel-data --chat-id -1001234567890 --service-stopped --apply
   ```

脚本在写入前使用 SQLite 在线备份 API 创建 `.tunnel-data/migration-backups/channel-id-*.sqlite`，然后在单个事务内更新文件，并逐条核对并发变化。失败时事务回滚。重复执行同一目标 ID 会显示 `changed: 0`。迁移后还要在后台把网盘托管频道配置改为同一个私有 chat ID；如果文件使用了独立 `backendId`，也要核对对应存储后端仍指向该频道。随后再启动服务并抽查文件列表、缩略图、Range 下载和删除。原有 Telegram caption 中的历史 `channel:` 文字不会自动编辑。
