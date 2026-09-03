'use strict';
// Host-specific bridge. Neither the disk API nor disk UI imports tunnel state.
(function () {
    let host;
    const LAST_TARGET = 'telegram-drive-last-tunnel';
    const PENDING = 'telegram-drive-pending-forward';
    window.DiskTunnelAdapter = {
        configure(value) { host = value; window.DiskUI.setExporter(exportFiles); resumePendingForward(); },
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
    async function chooseTarget() {
        const current = host?.target?.();
        if (!host?.tunnels || typeof document === 'undefined') return current ? { id: String(current?.id || current), label: String(current?.shortCode || current?.id || current), current: true } : null;
        const tunnels = await host.tunnels();
        if (!tunnels.length) throw new Error('没有可用的本机隧道记录');
        const dialog = document.createElement('dialog'); dialog.className = 'disk-tunnel-picker';
        const title = document.createElement('strong'); title.textContent = '选择转发目标隧道';
        const hint = document.createElement('p'); hint.textContent = '若选择其它隧道，将先完整缓存文件，再切换隧道继续原有发送和备注流程。';
        const select = document.createElement('select'); select.setAttribute('aria-label', '目标隧道');
        const remembered = localStorage.getItem(LAST_TARGET) || current?.id || current;
        for (const tunnel of tunnels) {
            const option = document.createElement('option'); option.value = tunnel.id;
            option.textContent = `${tunnel.shortCode || tunnel.id.slice(0, 8)}${tunnel.remark ? ` · ${tunnel.remark}` : ''}${tunnel.current ? ' · 【当前隧道】' : ''}`;
            if (tunnel.id === remembered || (!tunnels.some(item => item.id === remembered) && tunnel.current)) option.selected = true;
            select.append(option);
        }
        const actions = document.createElement('div');
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消';
        const confirm = document.createElement('button'); confirm.type = 'button'; confirm.textContent = '继续'; confirm.className = 'primary';
        actions.append(cancel, confirm); dialog.append(title, hint, select, actions); document.body.append(dialog); dialog.showModal(); select.focus();
        const id = await new Promise(resolve => {
            const finish = value => { dialog.close(); dialog.remove(); resolve(value); };
            cancel.onclick = () => finish(''); confirm.onclick = () => finish(select.value);
            dialog.oncancel = event => { event.preventDefault(); finish(''); };
            dialog.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); finish(select.value); } };
        });
        if (!id) return null;
        localStorage.setItem(LAST_TARGET, id);
        return tunnels.find(item => item.id === id) || null;
    }
    async function exportFiles(items) {
        const target = await chooseTarget();
        if (!target) throw new Error('请先连接目标隧道');
        const description = items.length === 1 ? '该文件将发送到所选隧道。' : `所选 ${items.length} 个文件将进入现有合辑/逐个发送及备注流程。`;
        if (!confirm('转发到隧道 ' + (target.shortCode || target.label || target.id) + '？' + description)) return;
        const files = [];
        for (const item of items) {
            const blob = await window.DiskClient.read(item);
            const file = new File([blob], item.name, { type: item.type });
            if (item.relativePath) Object.defineProperty(file, 'relativePath', { value: item.relativePath });
            files.push(file);
        }
        const current = host.target();
        const currentId = String(current?.id || current || '');
        if (target.id !== currentId) {
            sessionStorage.setItem(PENDING, JSON.stringify({ targetId: target.id, files: items.map(item => ({ id: item.id, name: item.name, type: item.type, relativePath: item.relativePath || '' })) }));
            window.DiskUI.close(); host.navigate(target.id); return;
        }
        window.DiskUI.close();
        return host.send(files);
    }
    async function resumePendingForward() {
        if (typeof sessionStorage === 'undefined' || !host?.send) return;
        let pending; try { pending = JSON.parse(sessionStorage.getItem(PENDING) || 'null'); } catch (_) {}
        const current = host.target();
        if (!pending?.files?.length || pending.targetId !== String(current?.id || current || '')) return;
        sessionStorage.removeItem(PENDING);
        try {
            const files = [];
            for (const item of pending.files) {
                const cached = await window.TelegramDriveCache?.get(item.id);
                if (!cached?.blob) throw new Error('切换隧道后找不到完整网盘缓存，请重新转发');
                const file = new File([cached.blob], item.name, { type: item.type });
                if (item.relativePath) Object.defineProperty(file, 'relativePath', { value: item.relativePath });
                files.push(file);
            }
            await host.send(files);
        } catch (error) {
            sessionStorage.setItem(PENDING, JSON.stringify(pending));
            alert(error.message);
        }
    }
})();
