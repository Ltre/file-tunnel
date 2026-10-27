(function (global) {
    'use strict';
    const rows = [
        ['已跳过 {0} 项（读取权限受限）：','Skipped {0} items (read access denied):'],
        ['备份完成（有跳过项）','Backup completed with skipped items'],
        ['系统备份程序', 'System Backup'],
        ['将服务器 .tunnel-data 保存到专用 Telegram 网盘位置。', 'Back up server .tunnel-data to a dedicated Telegram drive location.'],
        ['备份模式', 'Backup mode'], ['全量备份', 'Full backup'], ['核心备份', 'Core backup'], ['全量', 'Full'], ['核心', 'Core'],
        ['备份整个 .tunnel-data，排除可舍弃的 Telegram 内容缓存、上传暂存和分片缓存。', 'Back up all .tunnel-data except disposable Telegram content cache, upload staging and part cache.'],
        ['排除：telegram-content-cache、telegram-drive-staging、telegram-part-cache', 'Excluded: telegram-content-cache, telegram-drive-staging, telegram-part-cache'],
        ['备份数据根目录中的全部普通文件，以及核心业务目录。', 'Back up every regular file in the data root and the core business directories.'],
        ['核心目录：disk-spaces、streaming-console、youtube-premium-downloads、sns-downloads', 'Core directories: disk-spaces, streaming-console, youtube-premium-downloads, sns-downloads'],
        ['尚未设置备份位置', 'Backup destination is not configured'], ['设置备份位置', 'Set backup destination'], ['开始全量备份', 'Start full backup'], ['开始核心备份', 'Start core backup'],
        ['备份保存方式', 'How backups are saved'],
        ['每次在指定目录下创建“步进序号-YYYYMMDD”子目录，两种模式分别保留历史版本。文件由后端逐个读取并保存，不经过浏览器上传。', 'Each run creates a sequence-YYYYMMDD subdirectory. Both modes retain prior versions. Files are read and saved by the backend without browser uploads.'],
        ['在线备份按文件依次取快照：每个 SQLite 数据库使用在线备份读取已提交 WAL，快照不另存其 WAL／SHM；不同数据库和普通文件不构成全局事务。超大文件自动分段，备份清单记录原路径、分段顺序和 SHA-256。恢复前应停止应用写入，并依据清单恢复；本页不提供一键恢复。', 'Online backups snapshot each file in turn. SQLite online backups include committed WAL without separate WAL/SHM files. Files and databases do not form one global transaction. Large files are split; the manifest records original paths, segment order and SHA-256. Stop application writes before restoring from the manifest. This page does not offer one-click restore.'],
        ['备份包含密钥、Cookie 和账号资料，请使用专用账号及受控目录。失败或取消后保留已完成文件和本机快照，可重试；释放本机快照不会删除网盘内容。', 'Backups contain keys, cookies and account data. Use a dedicated account and controlled directory. Failed or cancelled runs retain saved files and local snapshots for retry. Releasing a local snapshot does not delete drive contents.'],
        ['备份任务', 'Backup jobs'], ['专用网盘账号', 'Dedicated drive account'], ['网盘分区', 'Drive partition'], ['当前目录', 'Current directory'], ['根目录', 'Root directory'], ['上级目录', 'Parent directory'],
        ['选择已有目录后保存配置。备份会在其下新建版本目录。', 'Choose an existing directory and save the configuration. Each backup creates a version directory inside it.'],
        ['保存位置', 'Save destination'], ['全量备份位置', 'Full backup destination'], ['核心备份位置', 'Core backup destination'],
        ['正在创建快照', 'Creating snapshot'], ['正在保存到网盘', 'Saving to drive'], ['正在取消', 'Cancelling'], ['已取消', 'Cancelled'], ['失败，可重试', 'Failed; retry available'],
        ['进程中断，可重试', 'Interrupted; retry available'], ['备份完成', 'Backup completed'], ['已释放本机快照', 'Local snapshot released'],
        ['操作未完成：{0}', 'Operation incomplete: {0}'], ['尚无备份任务。', 'No backup jobs yet.'],
        ['{0} · {1} / {2} 个文件 · {3} / {4}', '{0} · {1} / {2} files · {3} / {4}'], ['当前文件：{0}', 'Current file: {0}'],
        ['未完成：{0}。已完成的文件不会重复保存。', 'Incomplete: {0}. Completed files will not be saved twice.'],
        ['网盘备份已完成，本机快照清理失败：{0}', 'Drive backup is complete, but local snapshot cleanup failed: {0}'],
        ['取消备份', 'Cancel backup'], ['重试', 'Retry'], ['释放本机快照', 'Release local snapshot'],
        ['释放后不能继续这次备份，网盘中已保存的文件会保留。确定释放？', 'This backup cannot be resumed after releasing its snapshot. Saved drive files will remain. Release it?'],
        ['读取备份状态失败：{0}', 'Could not read backup status: {0}'], ['正在加载分区与目录…', 'Loading partitions and directories…'],
        ['点击目录继续进入，或保存当前位置。', 'Open a directory or save the current destination.'], ['当前目录没有子目录。', 'This directory has no subdirectories.'],
        ['目录读取失败：{0}', 'Could not read directories: {0}'], ['系统中没有网盘账号，请先添加备份专用账号。', 'No drive account exists. Add a dedicated backup account first.'],
        ['备份未能开始：{0}', 'Backup could not start: {0}'], ['备份位置已保存。', 'Backup destination saved.'], ['保存位置失败：{0}', 'Could not save destination: {0}']
    ];
    const catalog = global.Drop2TunnelI18nCatalog ||= {};
    for (const [source, en] of rows) if (!catalog[source]) catalog[source] = { en };
})(window);
