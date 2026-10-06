'use strict';
(function () {
    async function read(path) {
        const response = await fetch('/api/telegram/drive' + path, { credentials: 'same-origin', cache: 'no-store' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `HTTP_${response.status}`);
        return data;
    }
    async function choose(title) {
        const spaces = (await read('/spaces')).spaces || [];
        const dialog = document.createElement('dialog'); dialog.className = 'disk-copy-picker';
        const heading = document.createElement('h2'); heading.textContent = title || '转存到自己的网盘';
        const spaceLabel = document.createElement('label'); spaceLabel.textContent = '网盘分区';
        const space = document.createElement('select');
        for (const item of spaces) { const option = document.createElement('option'); option.value = item.id; option.textContent = item.name; space.append(option); }
        spaceLabel.append(space);
        const directoryLabel = document.createElement('label'); directoryLabel.textContent = '目标目录';
        const directory = document.createElement('select'); directoryLabel.append(directory);
        const error = document.createElement('p'); error.className = 'disk-copy-error'; error.setAttribute('role', 'alert');
        const actions = document.createElement('div'); actions.className = 'disk-copy-actions';
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消';
        const save = document.createElement('button'); save.type = 'button'; save.textContent = '转存'; save.className = 'primary';
        actions.append(cancel, save); dialog.append(heading, spaceLabel, directoryLabel, error, actions);
        document.body.append(dialog);
        const loadDirectories = async () => {
            save.disabled = true; error.textContent = ''; directory.replaceChildren();
            try {
                const entries = (await read('/directories?disk_space=' + encodeURIComponent(space.value))).directories || [];
                const root = document.createElement('option'); root.value = ''; root.textContent = '/（根目录）'; directory.append(root);
                for (const item of entries) { const option = document.createElement('option'); option.value = item.path; option.textContent = '/' + item.path; directory.append(option); }
            } catch (cause) { error.textContent = '目录读取失败：' + cause.message; }
            finally { save.disabled = !directory.options.length; }
        };
        space.onchange = loadDirectories;
        const result = new Promise(resolve => {
            const finish = value => { dialog.close(); dialog.remove(); resolve(value); };
            cancel.onclick = () => finish(null);
            save.onclick = () => finish({ diskSpace: space.value, destinationPath: directory.value });
            dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
        });
        dialog.showModal(); await loadDirectories();
        return result;
    }
    window.DiskCopyPicker = { choose };
})();
