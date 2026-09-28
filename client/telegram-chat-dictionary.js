'use strict';
(function () {
    const container = document.getElementById('telegramChatDictionaryRows');
    if (!container) return;
    const status = document.getElementById('telegramChatDictionaryStatus');
    const save = document.getElementById('telegramChatDictionarySave');
    const reload = document.getElementById('telegramChatDictionaryReload');
    const add = document.getElementById('telegramChatDictionaryAdd');
    let entries = [], revision = '', busy = false;
    function message(text, error = false) { status.textContent = text; status.className = 'status ' + (error ? 'error' : 'ok'); }
    function render() {
        container.replaceChildren();
        for (const row of entries) {
            const group = document.createElement('fieldset');
            group.style.cssText = 'min-width:0;border:1px solid var(--line);border-radius:10px;margin:16px 0;padding:14px';
            const makeInput = (caption, key, placeholder) => {
                const label = document.createElement('label'); label.className = 'field'; label.append(caption);
                const input = document.createElement('input'); input.type = 'text'; input.value = key === 'aliases' ? row.aliases.join(', ') : row[key];
                input.placeholder = placeholder; input.autocomplete = 'off'; input.disabled = busy;
                input.oninput = () => { row[key] = key === 'aliases' ? input.value.split(/[,，\n]/).map(value => value.trim()).filter(Boolean) : input.value; };
                label.append(input); group.append(label);
            };
            makeInput('Chat ID', 'chatId', '-1001234567890');
            makeInput('public 名称（可选）', 'username', '@example_channel');
            makeInput('备注 / 显示名称', 'label', '方便辨认此 Chat');
            makeInput('历史 public 别名（可选，逗号分隔）', 'aliases', '@old_channel, @older_channel');
            const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn'; remove.textContent = '删除映射'; remove.style.color = 'var(--danger)'; remove.disabled = busy;
            remove.onclick = () => { entries = entries.filter(value => value !== row); render(); message('修改尚未保存'); };
            group.append(remove); container.append(group);
        }
    }
    async function request(options) {
        const response = await fetch('/api/telegram/chat-dictionary', { cache: 'no-store', ...options });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Chat 字典请求失败');
        return data;
    }
    function setBusy(value) { busy = value; save.disabled = value; reload.disabled = value; add.disabled = value; container.querySelectorAll('input,button').forEach(input => { input.disabled = value; }); }
    async function load() {
        setBusy(true);
        try { const data = await request(); entries = data.entries; revision = data.revision; render(); message('Chat 字典已加载'); }
        catch (error) { message(error.message, true); }
        finally { setBusy(false); if (!revision) save.disabled = true; }
    }
    add.onclick = () => { entries.push({ chatId: '', username: '', label: '', aliases: [] }); render(); message('修改尚未保存'); };
    reload.onclick = load;
    save.onclick = async () => {
        setBusy(true);
        try {
            const data = await request({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries, revision }) });
            entries = data.entries; revision = data.revision; render(); message('Chat 字典已保存');
        } catch (error) { message(error.message, true); }
        finally { setBusy(false); }
    };
    load();
})();
