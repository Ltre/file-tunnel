(function () {
    'use strict';
    const $ = id => document.getElementById(id);
    const state = { users: [], spacesByUser: {}, backends: [], credentials: [], editing: null };
    const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
    const option = (value, text) => { const node = el('option', text); node.value = value; return node; };
    function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
    async function api(suffix = '', options = {}) {
        const response = await fetch('/api/admin/s3-credentials' + suffix, { credentials: 'same-origin', cache: 'no-store', ...options,
            headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `请求失败：HTTP ${response.status}`);
        return data;
    }
    const json = (method, body) => ({ method, body: JSON.stringify(body) });
    async function action(button, task) {
        button.disabled = true;
        try { await task(); }
        catch (error) { status(error.message, true); }
        finally { button.disabled = false; }
    }
    function fillUsers(select, selected) {
        select.replaceChildren(option('', '请选择网盘账号'));
        for (const user of state.users) select.append(option(user.id, `${user.name}${user.username && user.username !== user.name ? ' · ' + user.username : ''}（${user.id}）`));
        select.value = selected || '';
    }
    function addMapping(container, userId, mapping = {}) {
        const row = el('div', undefined, 'mapping');
        const bucket = el('input'); bucket.className = 'bucket'; bucket.required = true; bucket.maxLength = 63; bucket.placeholder = '例如：backup'; bucket.value = mapping.bucket || '';
        const space = el('select'); space.className = 'space';
        for (const name of state.spacesByUser[userId] || ['']) space.append(option(name, name || '默认分区'));
        if (mapping.diskSpace !== undefined && ![...space.options].some(item => item.value === mapping.diskSpace)) space.append(option(mapping.diskSpace, `${mapping.diskSpace || '默认分区'}（请核对）`));
        space.value = mapping.diskSpace || '';
        const backend = el('select'); backend.className = 'backend'; backend.append(option('', '默认网盘后端'));
        for (const item of state.backends) backend.append(option(item.id, `${item.channelId || '存储后端'} · ${item.id}`));
        if (mapping.backendId && ![...backend.options].some(item => item.value === mapping.backendId)) backend.append(option(mapping.backendId, '原后端已不存在（请核对）'));
        backend.value = mapping.backendId || '';
        for (const [name, control] of [['Bucket', bucket], ['网盘分区', space], ['上传存储后端', backend]]) { const label = el('label', name); label.append(control); row.append(label); }
        const remove = el('button', '×', 'btn danger'); remove.type = 'button'; remove.title = '移除此映射'; remove.addEventListener('click', () => row.remove()); row.append(remove);
        container.append(row);
    }
    const mappings = container => [...container.children].map(row => ({ bucket: row.querySelector('.bucket').value, diskSpace: row.querySelector('.space').value,
        ...(row.querySelector('.backend').value ? { backendId: row.querySelector('.backend').value } : {}) }));
    function resetMappings(prefix) {
        const container = $(prefix + 'Mappings'); container.replaceChildren(); addMapping(container, $(prefix + 'User').value);
    }
    function showSecret(credential) {
        $('generatedAccessKey').value = credential.accessKeyId; $('generatedSecret').value = credential.secretAccessKey;
        $('secretPanel').hidden = false; $('secretPanel').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    function dismissSecret() { $('generatedAccessKey').value = ''; $('generatedSecret').value = ''; $('secretPanel').hidden = true; }
    function openEdit(credential) {
        state.editing = credential;
        $('editAccessKey').textContent = credential.accessKeyId; $('editRemark').value = credential.remark;
        fillUsers($('editUser'), credential.userId); $('editEnabled').checked = credential.enabled;
        $('editMappings').replaceChildren();
        for (const mapping of credential.bucketMappings) addMapping($('editMappings'), credential.userId, mapping);
        $('editError').textContent = ''; $('editDialog').showModal();
    }
    function renderList() {
        const list = $('credentialList'); list.replaceChildren();
        for (const credential of state.credentials) {
            const card = el('article', undefined, 'credential'), head = el('div', undefined, 'credential-head');
            head.append(el('strong', credential.remark || '未填写备注'), el('span', credential.enabled ? '启用' : '停用', 'badge' + (credential.enabled ? '' : ' disabled')));
            card.append(head, el('p', credential.accessKeyId));
            const user = state.users.find(item => item.id === credential.userId);
            card.append(el('p', `网盘账号：${user?.name || '账号已不存在'} · ${credential.userId}`, 'hint'));
            const summary = el('ul', undefined, 'mapping-list');
            for (const mapping of credential.bucketMappings) summary.append(el('li', `${mapping.bucket} → ${mapping.diskSpace || '默认分区'}${mapping.backendId ? ' · 指定存储后端' : ''}`));
            card.append(summary);
            const buttons = el('div', undefined, 'actions');
            const edit = el('button', '修改', 'btn'); edit.type = 'button'; edit.addEventListener('click', () => openEdit(credential));
            const toggle = el('button', credential.enabled ? '停用' : '启用', 'btn' + (credential.enabled ? ' danger' : ''));
            toggle.type = 'button'; toggle.addEventListener('click', () => action(toggle, async () => {
                await api('/' + encodeURIComponent(credential.accessKeyId), json('PATCH', { enabled: !credential.enabled, updatedAt: credential.updatedAt }));
                await load(false); status(credential.enabled ? '接入已停用，新请求立即失效' : '接入已启用');
            }));
            const rotate = el('button', '轮换 Secret', 'btn'); rotate.type = 'button'; rotate.addEventListener('click', () => {
                if (!confirm('轮换后原 Secret 将立即失效，需要更新第三方客户端。确定轮换吗？')) return;
                action(rotate, async () => { const data = await api('/' + encodeURIComponent(credential.accessKeyId) + '/rotate', json('POST', { updatedAt: credential.updatedAt })); showSecret(data.credential); await load(false); status('Secret 已轮换，请更新第三方客户端'); });
            });
            buttons.append(edit, toggle, rotate); card.append(buttons); list.append(card);
        }
    }
    async function load(initial = false) {
        const selected = $('createUser').value;
        const data = await api(); Object.assign(state, data);
        $('endpoint').textContent = data.connection.endpoint; $('region').textContent = data.connection.region;
        fillUsers($('createUser'), selected);
        if (initial) resetMappings('create');
        renderList();
    }
    $('createUser').addEventListener('change', () => resetMappings('create'));
    $('editUser').addEventListener('change', () => resetMappings('edit'));
    $('addCreateMapping').addEventListener('click', () => addMapping($('createMappings'), $('createUser').value));
    $('addEditMapping').addEventListener('click', () => addMapping($('editMappings'), $('editUser').value));
    $('createForm').addEventListener('submit', event => {
        event.preventDefault();
        action($('createCredential'), async () => {
            const data = await api('', json('POST', { userId: $('createUser').value, remark: $('createRemark').value, bucketMappings: mappings($('createMappings')) }));
            showSecret(data.credential); await load(false); status('独立凭据已建立');
        });
    });
    $('editForm').addEventListener('submit', async event => {
        event.preventDefault(); if (!state.editing) return;
        const button = $('saveEdit'); button.disabled = true; $('editError').textContent = '';
        try {
            await api('/' + encodeURIComponent(state.editing.accessKeyId), json('PATCH', { userId: $('editUser').value, remark: $('editRemark').value, enabled: $('editEnabled').checked,
                bucketMappings: mappings($('editMappings')), updatedAt: state.editing.updatedAt }));
            $('editDialog').close(); await load(false); status('接入配置已更新');
        } catch (error) { $('editError').textContent = error.message; }
        finally { button.disabled = false; }
    });
    const editDialog = $('editDialog');
    let backdropPointer = null, backdropGesture = false;
    function outsideEditDialog(event) {
        const rect = editDialog.getBoundingClientRect();
        return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
    }
    function resetBackdropGesture() { backdropPointer = null; backdropGesture = false; }
    $('cancelEdit').addEventListener('click', () => editDialog.close());
    editDialog.addEventListener('pointerdown', event => {
        backdropGesture = false;
        backdropPointer = editDialog.open && event.target === editDialog && outsideEditDialog(event) ? event.pointerId : null;
    });
    editDialog.addEventListener('pointerup', event => {
        backdropGesture = backdropPointer !== null && backdropPointer === event.pointerId && editDialog.open && event.target === editDialog && outsideEditDialog(event);
        backdropPointer = null;
    });
    editDialog.addEventListener('pointercancel', resetBackdropGesture);
    editDialog.addEventListener('click', event => {
        // Opening showModal() can retarget the initiating click to the dialog.
        // Only a complete gesture on the actual backdrop is a dismiss action.
        const dismiss = backdropGesture && event.target === editDialog && outsideEditDialog(event);
        resetBackdropGesture();
        if (dismiss) { event.preventDefault(); event.stopPropagation(); editDialog.close(); }
    });
    editDialog.addEventListener('close', () => { resetBackdropGesture(); state.editing = null; });
    $('refreshCredentials').addEventListener('click', () => action($('refreshCredentials'), async () => { await load(false); status('配置已刷新'); }));
    $('dismissSecret').addEventListener('click', dismissSecret);
    $('copyGenerated').addEventListener('click', () => action($('copyGenerated'), async () => { await navigator.clipboard.writeText(`Endpoint: ${$('endpoint').textContent}\nRegion: ${$('region').textContent}\nPath-style: true\nAccess Key ID: ${$('generatedAccessKey').value}\nSecret Access Key: ${$('generatedSecret').value}`); status('接入信息已复制'); }));
    window.addEventListener('pagehide', dismissSecret);
    load(true).then(() => status('')).catch(error => status(error.message, true));
})();
