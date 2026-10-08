'use strict';
// A collaboration mount is a local leaf pointer. This module never traverses
// the foreign namespace or presents it as a native directory/file.
(function () {
    const base = '/api/telegram/drive';
    const scopeKey = space => String(space?.scopeKey ?? space?.diskSpace ?? space?.id ?? '');
    const spaceId = space => String(space?.id ?? scopeKey(space));
    const mountId = mount => String(mount?.mountId || mount?.id || '');
    const checkedName = value => {
        const name = String(value ?? '');
        if (!name || name !== name.trim() || name === '.' || name === '..' || name.length > 100 || /[\\/:*?"<>|\u0000-\u001f]/.test(name))
            throw new Error('挂载名称不能为空、超过 100 字或包含 \\ / : * ? " < > | 等非法字符');
        return name;
    };
    const checkedNavigationPath = value => {
        const path = String(value ?? '');
        if (!path) return '';
        const parts = path.split('/');
        if (path.length > 2048 || parts.length > 20 || parts.some(part => !part || part !== part.trim() || part === '.' || part === '..' || part.length > 100 || /[\\/:*?"<>|\u0000-\u001f]/.test(part)))
            throw new Error('协同定位路径不合法');
        return path;
    };
    const suggestedName = value => String(value || '协同项目').trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').slice(0, 100) || '协同项目';

    async function request(scope, route, options = {}) {
        const address = new URL(base + route, location.origin);
        address.searchParams.set('disk_space', String(scope ?? ''));
        let deviceId = '';
        try { deviceId = localStorage.getItem('disk-device-id') || ''; } catch (_) {}
        const response = await fetch(address.pathname + address.search, {
            credentials: 'same-origin', cache: 'no-store', ...options,
            headers: { ...(deviceId ? { 'X-Disk-Device-Id': deviceId } : {}), ...options.headers }
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) { const error = new Error(data.error || `HTTP_${response.status}`); error.status = response.status; Object.assign(error, data); throw error; }
        return data;
    }
    const json = (method, body) => ({ method, headers: { 'Content-Type':'application/json' }, body: JSON.stringify(body) });

    function defaultDialog({ title, body, confirmText = '确定', validate }) {
        const dialog = document.createElement('dialog'); dialog.className = 'disk-mount-dialog';
        const heading = document.createElement('h2'); heading.textContent = title;
        const content = document.createElement('div'); content.className = 'disk-mount-dialog-content';
        content.append(...(Array.isArray(body) ? body : [body]).filter(Boolean));
        const error = document.createElement('p'); error.className = 'disk-mount-error'; error.setAttribute('role', 'alert');
        const actions = document.createElement('div'); actions.className = 'disk-mount-dialog-actions';
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消';
        const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'primary'; confirm.textContent = confirmText;
        actions.append(cancel, confirm); dialog.append(heading, content, error, actions); document.body.append(dialog);
        return new Promise(resolve => {
            let done = false;
            const finish = result => { if (done) return; done = true; dialog.close(); dialog.remove(); resolve(result); };
            cancel.onclick = () => finish(null);
            confirm.onclick = async () => {
                if (confirm.disabled) return; confirm.disabled = true; error.textContent = '';
                try { const result = validate ? await validate() : true; if (result !== false) finish(result); }
                catch (cause) { if (!done) error.textContent = cause.message || '操作失败'; }
                finally { confirm.disabled = false; }
            };
            dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
            dialog.showModal();
        });
    }

    async function availableSpaces(options) {
        const items = (options.spaces || (await request(options.currentSpace || '', '/spaces')).spaces || [])
            .filter(space => !space.state || space.state === 'ACTIVE');
        if (!items.length) throw new Error('尚无可用的本人网盘分区');
        return items;
    }
    async function waitDirectoryOperation(scope, response) {
        if (response.status === 'completed') return response.result;
        if (!response.operation_id) return response;
        for (let attempt = 0; attempt < 120; attempt++) {
            const operation = await request(scope, '/operations/' + encodeURIComponent(response.operation_id));
            if (operation.status === 'completed') return operation.result;
            if (['failed', 'cancelled'].includes(operation.status)) throw new Error(operation.error || '创建目录失败');
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        throw new Error('创建目录超时，请刷新后检查目录是否已建立');
    }

    async function chooseTarget(options = {}) {
        if (!window.DiskDirectoryPicker?.choose) throw new Error('网盘目录选择器未加载');
        const spaces = await availableSpaces(options);
        const selectedSpace = spaces.find(space => spaceId(space) === String(options.currentSpace ?? '') || scopeKey(space) === String(options.currentSpace ?? '')) || spaces[0];
        const controls = document.createElement('div'); controls.className = 'disk-mount-picker-controls';
        const partitionLabel = document.createElement('label'); partitionLabel.textContent = '目标网盘分区';
        const partition = document.createElement('select'); partition.setAttribute('aria-label', '目标网盘分区');
        for (const space of spaces) { const option = document.createElement('option'); option.value = spaceId(space); option.textContent = space.displayName || space.name || '默认分区'; partition.append(option); }
        partition.value = spaceId(selectedSpace); partitionLabel.append(partition); controls.append(partitionLabel);
        const nameLabel = document.createElement('label'); nameLabel.textContent = '挂载名称';
        const name = document.createElement('input'); name.type = 'text'; name.maxLength = 100; name.value = options.name || '协同项目'; name.setAttribute('aria-label', '挂载名称');
        nameLabel.append(name); if (options.includeName !== false) controls.append(nameLabel);
        const pickerBody = document.createElement('div'); pickerBody.className = 'disk-mount-picker-body';
        const pickerError = document.createElement('p'); pickerError.className = 'disk-mount-error'; pickerError.setAttribute('role', 'alert');
        const chosen = () => spaces.find(space => spaceId(space) === partition.value);
        const scope = () => scopeKey(chosen());
        let reloadTree = null;
        partition.onchange = () => { pickerError.textContent = ''; reloadTree?.().catch(error => { pickerError.textContent = error.message; }); };
        const open = options.openDialog || defaultDialog;
        return window.DiskDirectoryPicker.choose({
            title: options.title || '挂载到我的网盘', confirmText: options.confirmText || '创建挂载',
            rootPath: '', rootName: '根目录', initialPath: options.initialPath || '', controls: [controls, pickerError],
            onReady: reload => { reloadTree = reload; },
            loadDirectories: () => request(scope(), '/directories'),
            createDirectory: async path => waitDirectoryOperation(scope(), await request(scope(), '/directories', json('POST', { path }))),
            showError: error => { pickerError.textContent = error.message || '选择目录失败'; },
            openDialog: pickerOptions => {
                pickerBody.replaceChildren(...pickerOptions.body);
                return open({ ...pickerOptions, body: pickerBody, validate: async () => ({
                    parentPath: await pickerOptions.validate(), name: checkedName(name.value),
                    targetSpace: partition.value, targetDiskSpace: scope()
                }) });
            }
        });
    }

    async function create(options = {}) {
        const grant = options.collaboration;
        const collaborationId = String(grant?.id || grant?.collaborationId || '');
        if (!collaborationId || grant?.owned) throw new Error('只能挂载自己已加入的其他用户协同项目');
        const chosen = options.selectTarget ? await options.selectTarget() : await chooseTarget({
            ...options, name: options.name || suggestedName(grant.name || grant.lastKnownTitle)
        });
        if (!chosen) return null;
        const name = checkedName(chosen.name);
        const result = await request(chosen.targetDiskSpace, '/mounts', json('POST', {
            collaborationId, parentPath: chosen.parentPath, name
        }));
        await options.onChanged?.(result.mount || result);
        return result.mount || result;
    }
    async function rename(mount, options = {}) {
        if (!mountId(mount)) throw new Error('挂载不存在');
        const input = document.createElement('input'); input.type = 'text'; input.maxLength = 100; input.value = mount.name || '';
        input.setAttribute('aria-label', '新的挂载名称');
        const label = document.createElement('label'); label.className = 'disk-mount-name-label'; label.textContent = '挂载名称'; label.append(input);
        const chosen = options.selectName ? await options.selectName(mount) : await (options.openDialog || defaultDialog)({
            title: '重命名挂载', body: label, confirmText: '保存名称', validate: () => checkedName(input.value)
        });
        if (chosen === null) return null;
        const result = await request(mount.diskSpace || '', '/mounts/' + encodeURIComponent(mountId(mount)), json('PATCH', { name: checkedName(chosen) }));
        await options.onChanged?.(result.mount || result);
        return result.mount || result;
    }
    async function move(mount, options = {}) {
        if (!mountId(mount)) throw new Error('挂载不存在');
        const chosen = options.selectTarget ? await options.selectTarget() : await chooseTarget({
            ...options, title: '移动挂载到我的网盘', confirmText: '移动挂载', name: mount.name, includeName: false,
            currentSpace: mount.diskSpace || options.currentSpace, initialPath: mount.parentPath || ''
        });
        if (!chosen) return null;
        const result = await request(mount.diskSpace || '', '/mounts/' + encodeURIComponent(mountId(mount)), json('PATCH', {
            parentPath: chosen.parentPath, targetSpace: chosen.targetSpace
        }));
        await options.onChanged?.(result.mount || result);
        return result.mount || result;
    }
    async function remove(mount, options = {}) {
        if (!mountId(mount)) throw new Error('挂载不存在');
        const message = document.createElement('p'); message.textContent = '只移除自己网盘中的挂载入口。对方的文件、协同授权和 Telegram 内容均不会删除。';
        const confirmed = options.confirm ? await options.confirm(mount) : await (options.openDialog || defaultDialog)({
            title: `移除挂载：${mount.name || '协同项目'}`, body: message, confirmText: '移除挂载'
        });
        if (!confirmed) return null;
        const result = await request(mount.diskSpace || '', '/mounts/' + encodeURIComponent(mountId(mount)), { method:'DELETE' });
        await options.onChanged?.(mount);
        return result;
    }
    function open(mount, options = {}) {
        if (mount?.status === 'inaccessible') throw new Error('该协同授权已失效；只能移除本地挂载');
        const id = String(mount?.collaborationId || '');
        if (!id) throw new Error('挂载缺少协同项目标识');
        if (!mountId(mount)) throw new Error('挂载不存在');
        const path = checkedNavigationPath(options.path);
        const fileId = String(options.fileId || '');
        if (options.openFrame) return options.openFrame({ id, name: mount.name, mountId: mountId(mount), path, ...(fileId ? { fileId } : {}) });
        const dialog = document.createElement('dialog'); dialog.className = 'disk-mount-frame';
        dialog.setAttribute('aria-label', `协同挂载：${mount.name || '协同项目'}`);
        const header = document.createElement('header'); header.className = 'disk-mount-frame-header';
        const locationText = document.createElement('strong'); locationText.textContent = ['我的网盘', mount.parentPath, mount.name || '协同项目'].filter(Boolean).join(' / ');
        const source = document.createElement('span'); source.textContent = mount.lastKnownTitle ? `来源：${mount.lastKnownTitle}` : '协同项目';
        header.append(locationText, source);
        const frame = document.createElement('iframe'); frame.title = `协同项目：${mount.name || '协同项目'}`;
        const url = new URL('/disk-collab/view/' + encodeURIComponent(id), location.origin);
        url.searchParams.set('embedded','1'); url.searchParams.set('mount_id',mountId(mount));
        if (path) url.searchParams.set('path', path);
        if (fileId) url.searchParams.set('file_id', fileId);
        frame.src = url.pathname + url.search;
        const closeButton = document.createElement('button'); closeButton.type = 'button'; closeButton.textContent = '返回我的网盘'; closeButton.setAttribute('aria-label','返回我的网盘');
        const close = () => { window.removeEventListener('message',onMessage); frame.src = 'about:blank'; dialog.close(); dialog.remove(); };
        const onMessage = event => { if (event.origin === location.origin && event.source === frame.contentWindow && event.data?.type === 'disk-collaboration:close') close(); };
        closeButton.onclick = close; dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
        header.append(closeButton); dialog.append(header, frame); document.body.append(dialog); window.addEventListener('message',onMessage); dialog.showModal();
        return { dialog, close };
    }
    window.DiskMountUI = { create, rename, move, remove, open, chooseTarget, _test:{ checkedName, checkedNavigationPath, scopeKey, spaceId } };
})();
