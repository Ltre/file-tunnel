'use strict';
(function () {
    const target = document.getElementById('diskApps');
    const status = document.getElementById('diskAppsStatus');
    async function request(url, options) {
        const response = await fetch('/api/telegram/disk-admin' + url, { cache: 'no-store', ...options });
        const data = await response.json(); if (!response.ok) throw new Error(data.error); return data;
    }
    function card(app = {}) {
        const form = document.createElement('form'); form.style.cssText = 'padding:16px 0;border-bottom:1px solid #ccd6e0;display:grid;gap:10px';
        const fields = {};
        for (const [key, label, type, value] of [
            ['app_id', 'App ID（必填）', 'text', app.app_id || ''],
            ['app_secret', app.app_id ? '重置 App Secret（留空保留，至少 16 位）' : 'App Secret（必填，至少 16 位）', 'password', ''],
            ['remark', '备注', 'text', app.remark || ''],
            ['passkey_origin', '第三方 Passkey 页面 Origin（可选，精确 HTTPS 来源，无尾部 /）', 'url', app.passkey_origin || '']
        ]) {
            const wrap = document.createElement('label'); wrap.textContent = label;
            const input = document.createElement('input'); input.name = key; input.type = type; input.value = value;
            input.style.width = '100%'; input.required = key === 'app_id' || (key === 'app_secret' && !app.app_id);
            input.readOnly = key === 'app_id' && Boolean(app.app_id);
            if (key === 'app_secret') { input.autocomplete = 'new-password'; input.minLength = 16; }
            fields[key] = input; wrap.append(input); form.append(wrap);
        }
        const label = document.createElement('label'), enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = app.enabled !== false; label.append(enabled, ' 启用此应用'); form.append(label);
        if (app.app_id) {
            const info = document.createElement('small'); info.textContent = '创建：' + new Date(app.createdAt).toLocaleString() + '；最近使用：' + (app.lastUsedAt ? new Date(app.lastUsedAt).toLocaleString() : '尚无') + '；最近签发：' + (app.lastIssuedAt ? new Date(app.lastIssuedAt).toLocaleString() : '尚无'); form.append(info);
        }
        const actions = document.createElement('div'); actions.className = 'actions';
        const save = document.createElement('button'); save.type = 'submit'; save.className = 'btn primary'; save.textContent = '保存应用';
        const generate = document.createElement('button'); generate.type = 'button'; generate.className = 'btn'; generate.textContent = '生成新密钥（仅本次显示）';
        generate.onclick = () => { const bytes = crypto.getRandomValues(new Uint8Array(32)); fields.app_secret.value = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); fields.app_secret.type = 'text'; };
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn'; remove.textContent = app.app_id ? '删除应用' : '取消';
        remove.onclick = async () => {
            if (!app.app_id) return form.remove();
            if (!confirm('删除此应用并撤销所有令牌？已存文件不会删除。')) return;
            try { await request('/apps/' + encodeURIComponent(app.app_id), { method: 'DELETE' }); await load(); } catch (error) { status.textContent = error.message; }
        };
        actions.append(save, generate, remove); form.append(actions);
        form.onsubmit = async event => {
            event.preventDefault(); save.disabled = true; status.textContent = '正在保存应用配置…';
            try {
                await request('/apps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value])), enabled: enabled.checked }) });
                status.textContent = '应用已保存。密钥不会从服务器重新展示，请妥善保管。'; await load();
            } catch (error) { status.textContent = error.message; } finally { save.disabled = false; }
        };
        target.append(form);
    }
    async function load() { const data = await request('/apps'); target.replaceChildren(); data.apps.forEach(card); }
    document.getElementById('diskAddApp').onclick = () => card();
    load().catch(error => { status.textContent = '读取应用配置失败：' + error.message; });
})();
