'use strict';
// Host-specific bridge. Neither the disk API nor disk UI imports tunnel state.
(function () {
    let host;
    window.DiskTunnelAdapter = {
        configure(value) { host = value; window.DiskUI.setExporter(exportFiles); },
        async save(record) {
            const status = await window.DiskClient.raw('/me');
            if (!status.identity) { await window.DiskUI.open(); throw new Error('请先登录网盘，再选择保存'); }
            const files = host.filesForRecord(record);
            if (!files.length) throw new Error('此记录没有文件');
            const folderPath = prompt('保存到网盘目录（留空为根目录，可输入多级路径）', window.DiskUI.path);
            if (folderPath === null) return;
            await window.DiskClient.upload(files, folderPath, host.readFile, { source: 'tunnel', recordId: record.id });
        }
    };
    async function exportFiles(items) {
        const target = host?.target();
        if (!target) throw new Error('请先连接目标隧道');
        const description = items.length === 1 ? '该文件将发送到当前隧道。' : `所选 ${items.length} 个文件将进入现有合辑/逐个发送及备注流程。`;
        if (!confirm('转发到当前隧道 ' + target + '？' + description)) return;
        const files = [];
        for (const item of items) {
            const blob = await window.DiskClient.read(item);
            const file = new File([blob], item.name, { type: item.type });
            if (item.relativePath) Object.defineProperty(file, 'relativePath', { value: item.relativePath });
            files.push(file);
        }
        if (host.target() !== target) throw new Error('目标隧道已变化，请重新选择转发');
        window.DiskUI.close();
        return host.send(files);
    }
})();
