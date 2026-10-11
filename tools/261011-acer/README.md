# 261011-acer：Acer 旧网盘数据库修复

专用于 Acer 上 schema version 3、`disk_contents(scope,id,...,payload)` 与 `disk_content_parts(scope,content_id,part_index,payload)` 的旧结构。解决新版启动时 `no such column: c.state`，以及通用 Content 迁移工具预检时 `no such table: disk_content_refs`。需要本项目当前分支及 Node 24.15+。

## 先预演

在项目根目录执行：

```powershell
node tools/261011-acer/repair.cjs --data-dir .tunnel-data
```

默认只读打开原数据库，用 SQLite backup API 把包含已提交 WAL 的一致性快照复制到系统临时目录。在副本上转换、检查物理定位及外键，并调用当前 repository 验证 schema 初始化和文件读取；结束后删除临时目录。不会修改原库、旧 JSON 或 Telegram 消息。

本机已验证的预演结果：42 条文件、42 条有效引用、10 条旧 Content；转换后 42 条新版 Content，0 条冲突。这里的 Content 数量可以增加：历史 SHA 不被当作已验证整文件 hash，所以不会仅凭旧 hash 合并。

## 执行修复

1. 停止使用该数据目录的全部本站服务进程，暂停自动重启，等待上传等任务结束。
2. 另行备份完整数据目录，包括 `disk.sqlite*`、密钥、配置与缓存。
3. 核对预演结果后执行：

```powershell
node tools/261011-acer/repair.cjs --data-dir .tunnel-data --apply --service-stopped
```

`--service-stopped` 是操作者的停服确认，工具不会代为终止进程。写入前再次核验并持有 SQLite 写锁，创建 `migration-backups/261011-acer-<时间>-<UUID>.sqlite` 一致性备份并检查备份完整性。转换、引用建立和核对在单个事务内执行，失败回滚。

修复后运行通用迁移工具的只读预检，再启动服务：

```powershell
node tools/migrate-tgdisk-content-objects.cjs --data-dir .tunnel-data
npm run dev
```

预检应显示 `unbound: 0`、`referenceMismatches: 0`。专用工具只转换 Content 结构，保留原 schema version 3；正常启动由当前 repository 完成版本 5 初始化及其余表创建。启动后抽查各分区列表、下载、Range、分享、协同及挂载。转换验证不包含 Telegram 回源验证。

目录也可用绝对路径；未指定 `--data-dir` 时使用 `TUNNEL_DATA_DIR`，再默认到当前目录的 `.tunnel-data`。非预期旧结构、混合结构、缺失 Content、非 READY 引用或不完整分片会拒绝操作。

## 保留与变化

- Logical File ID、scope、owner、名称及目录字段不变；分享、协同等外围表和原 `disk_file_parts` 不改写。
- 原 Content、分片及文件记录分别保留于 `acer_261011_contents`、`acer_261011_parts`、`acer_261011_files`，用于审计、旧状态和回退依据。不要随意删除这些归档表。
- 有旧 Content 引用时，以对应分区的旧 Content 及其分片为物理定位依据；未绑定文件使用自己的分片。建立新版 Content ID 和引用，旧 ID 可在归档中查找。
- 历史 hash 不自动标记 verified；旧清理债务和历史记录保留在归档，不生成远端清理任务。旧 mediaIndex 按当前服务规则降为 unavailable。旧健康和修复状态留在归档，新版从 unknown 开始。
- 发现相同物理消息集合时使用当前 repository 的归组规则，部分重叠按当前逻辑隔离。存在冲突应人工核对，避免立即进行删除操作。
- 成功后重复执行返回 `already-repaired`，不新增备份或改写数据。

失败请保持停服并保留报告和备份。如果需要回退，应在停服状态恢复一致性备份及对应旧代码；不要在新版已产生新数据后直接用旧备份覆盖。归档表不能替代完整备份。

## 验证工具

```powershell
node --test tools/261011-acer/repair.test.cjs
```

测试覆盖原库预演不变、写前备份、跨分区同名 Content、外围关系保留、幂等及事务中途失败回滚。
