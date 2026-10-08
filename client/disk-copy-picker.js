'use strict';
(function () {
    async function request(path, options = {}) {
        const response = await fetch('/api/telegram/drive' + path, { credentials: 'same-origin', cache: 'no-store', ...options });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `HTTP_${response.status}`);
        return data;
    }
    async function choose(title) {
        const spaces = (await request('/spaces')).spaces || [];
        if (!spaces.length) throw new Error('尚无可用网盘分区');
        const spaceLabel = document.createElement('label'); spaceLabel.textContent = '目标网盘分区';
        const space = document.createElement('select');
        for (const item of spaces) { const option = document.createElement('option'); option.value = item.id; option.textContent = item.name; space.append(option); }
        spaceLabel.append(space);
        let reloadTree = null;
        space.onchange = () => reloadTree?.().catch(error => { const output = document.querySelector('.disk-copy-error'); if (output) output.textContent = error.message; });
        const scoped = suffix => suffix + (suffix.includes('?') ? '&' : '?') + 'disk_space=' + encodeURIComponent(space.value);
        return window.DiskDirectoryPicker.choose({
            title: title || '转存到自己的网盘', confirmText: '转存', rootPath: '', rootName: '根目录',
            controls: [spaceLabel], onReady: reload => { reloadTree = reload; },
            loadDirectories: () => request(scoped('/directories')),
            createDirectory: async path => {
                const created = await request(scoped('/directories'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
                if (created.status === 'completed') return created.result;
                if (!created.operation_id) return created;
                for (let attempt = 0; attempt < 100; attempt++) {
                    const operation = await request(scoped('/operations/' + encodeURIComponent(created.operation_id)));
                    if (operation.status === 'completed') return operation.result;
                    if (['failed', 'cancelled'].includes(operation.status)) throw new Error(operation.error || '创建目录失败');
                    await new Promise(resolve => setTimeout(resolve, 150));
                }
                throw new Error('创建目录超时，请刷新后检查目录是否已建立');
            },
            openDialog: ({ title: heading, body, confirmText, validate }) => {
                const dialog = document.createElement('dialog'); dialog.className = 'disk-copy-picker';
                const headingNode = document.createElement('h2'); headingNode.textContent = heading;
                const content = document.createElement('div'); content.append(...body);
                const error = document.createElement('p'); error.className = 'disk-copy-error'; error.setAttribute('role', 'alert');
                const actions = document.createElement('div'); actions.className = 'disk-copy-actions';
                const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消';
                const save = document.createElement('button'); save.type = 'button'; save.textContent = confirmText; save.className = 'primary';
                actions.append(cancel, save); dialog.append(headingNode, content, error, actions); document.body.append(dialog);
                return new Promise(resolve => {
                    let done = false;
                    const finish = value => { if (done) return; done = true; dialog.close(); dialog.remove(); resolve(value); };
                    cancel.onclick = () => finish(null);
                    save.onclick = async () => {
                        save.disabled = true; error.textContent = '';
                        try { const path = await validate(); if (!done) finish({ diskSpace: space.value, destinationPath: path }); }
                        catch (cause) { if (!done) error.textContent = cause.message || '目标目录无效'; }
                        finally { save.disabled = false; }
                    };
                    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
                    dialog.showModal();
                });
            },
            showError: error => { const output = document.querySelector('.disk-copy-error'); if (output) output.textContent = error.message; }
        });
    }
    window.DiskCopyPicker = { choose };
})();
