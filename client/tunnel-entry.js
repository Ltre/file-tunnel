(function () {
    'use strict';
    const idPattern = /^[a-zA-Z0-9_-]{8,64}$/;
    const codePattern = /^[A-Z0-9]{5}$/;
    const codeOf = value => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    const makeId = () => crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => { const value = Math.random() * 16 | 0; return (char === 'x' ? value : (value & 3 | 8)).toString(16); });
    const landing = document.getElementById('sessionLanding');
    const note = document.getElementById('landingNote');
    const inputs = Array.from(document.querySelectorAll('#tunnelCodeInputs input'));
    const select = document.getElementById('landingSessionSelect');
    const recentButton = document.getElementById('landingRecentBtn');
    let sessions = [], joining = false;

    function openSession(id, replace = false) {
        const url = new URL('/', location.origin);
        url.searchParams.set('open', '1');
        if (id) url.hash = id;
        location[replace ? 'replace' : 'assign'](url.href);
    }
    function storedDirectory() {
        try { const entries = JSON.parse(localStorage.getItem('tunnelSessionDirectory:v1') || '[]'); return Array.isArray(entries) ? entries : []; }
        catch (_) { return []; }
    }
    function readDatabase() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('TunnelDB');
            let absent = false;
            request.onupgradeneeded = () => { absent = true; request.transaction.abort(); };
            request.onerror = () => absent ? resolve({ sessions: [], shared: 0 }) : reject(request.error);
            request.onblocked = () => reject(Error('数据库正在使用'));
            request.onsuccess = () => {
                const db = request.result;
                const names = ['sessions', 'shareQueue'].filter(name => db.objectStoreNames.contains(name));
                if (!names.length) { db.close(); resolve({ sessions: [], shared: 0 }); return; }
                const result = { sessions: [], shared: 0 };
                const tx = db.transaction(names, 'readonly');
                if (names.includes('sessions')) tx.objectStore('sessions').getAll().onsuccess = event => { result.sessions = event.target.result; };
                if (names.includes('shareQueue')) tx.objectStore('shareQueue').count().onsuccess = event => { result.shared = event.target.result; };
                tx.oncomplete = () => { db.close(); resolve(result); };
                tx.onerror = () => { db.close(); reject(tx.error); };
            };
        });
    }
    function authorization(id) {
        try {
            return JSON.parse(localStorage.getItem('tunnel-authorization:' + id) || 'null') || {
                deviceId: localStorage.getItem('deviceId'), grant: localStorage.getItem('tunnel-access:' + id) || ''
            };
        } catch (_) { return { deviceId: localStorage.getItem('deviceId'), grant: '' }; }
    }
    async function authorize(id, shortCode) {
        const auth = authorization(id);
        const deviceId = auth.deviceId || localStorage.getItem('deviceId') || makeId();
        if (!localStorage.getItem('deviceId')) localStorage.setItem('deviceId', deviceId);
        let response;
        try {
            response = await fetch('/api/tunnel-access', { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: JSON.stringify({ sessionId: id, deviceId, grant: auth.grant || '', shortCode, rejoin: true }) });
        } catch (error) { if (auth.grant) return; throw error; }
        if (response.status >= 500 && auth.grant) return;
        const data = await response.json();
        if (!response.ok || !data.allowed || !data.grant) throw Error(response.status === 429 ? '短码尝试过于频繁，请稍后再试' : '请使用有效短码选择并加入隧道');
        localStorage.setItem('tunnel-authorization:' + id, JSON.stringify({ deviceId: data.deviceId || deviceId, grant: data.grant }));
    }
    async function join(code) {
        if (joining || !codePattern.test(code)) return;
        joining = true; note.textContent = '正在查找传输隧道...';
        try {
            const response = await fetch('/api/short-codes/' + encodeURIComponent(code), { cache: 'no-store' });
            if (!response.ok) throw Error(response.status === 429 ? '短码尝试过于频繁，请稍后再试' : '没有找到该传输隧道，或它已经被删除。');
            const data = await response.json();
            if (!idPattern.test(data.sessionId || '')) throw Error('传输隧道响应无效。');
            await authorize(data.sessionId, code); openSession(data.sessionId);
        } catch (error) { note.textContent = error.message; joining = false; }
    }
    function fill(value) {
        const code = codeOf(value);
        inputs.forEach((input, i) => { input.value = code[i] || ''; });
        inputs[Math.min(code.length, inputs.length - 1)].focus();
        if (codePattern.test(code)) join(code);
    }
    inputs.forEach((input, i) => {
        input.addEventListener('input', event => {
            input.value = codeOf(event.data || input.value).slice(-1);
            if (input.value && inputs[i + 1]) inputs[i + 1].focus();
            const code = inputs.map(node => node.value).join('');
            if (codePattern.test(code)) join(code);
        });
        input.addEventListener('keydown', event => {
            if (event.key === 'Backspace' && !input.value && inputs[i - 1]) inputs[i - 1].focus();
            if (event.key === 'Enter') join(inputs.map(node => node.value).join(''));
        });
        input.addEventListener('paste', event => { event.preventDefault(); fill(event.clipboardData?.getData('text')); });
    });
    recentButton.addEventListener('click', async () => {
        if (joining || !idPattern.test(select.value)) return;
        joining = true;
        try { await authorize(select.value, codeOf(sessions.find(entry => entry.sessionId === select.value)?.shortCode)); openSession(select.value); }
        catch (error) { note.textContent = error.message; joining = false; }
    });
    document.getElementById('landingCreateBtn').addEventListener('click', () => {
        const id = makeId(); sessionStorage.setItem('tunnel-create:' + id, '1'); openSession(id);
    });
    async function start() {
        if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js').catch(() => {});
        const hash = location.hash.slice(1);
        if (/^[a-zA-Z0-9_-]{8,}$/.test(hash)) { openSession(hash, true); return; }
        let stored;
        try { stored = await readDatabase(); } catch (_) { openSession('', true); return; }
        sessions = (storedDirectory().length ? storedDirectory() : stored.sessions)
            .filter(entry => idPattern.test(entry.sessionId || '') && codePattern.test(String(entry.shortCode || '').trim().toUpperCase()))
            .sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
        if (!new URLSearchParams(location.search).has('leave') && !stored.shared && sessions.length) { openSession(sessions[0].sessionId, true); return; }
        if (stored.shared) { const notice = document.getElementById('sharedFilesNotice'); notice.hidden = false; notice.textContent = `已收到 ${stored.shared} 个分享文件，请选择要发送到的传输隧道。`; }
        if (sessions.length) {
            const recent = sessions[0].sessionId;
            sessions.slice().sort((a, b) => a.sessionId.localeCompare(b.sessionId, undefined, { numeric: true, sensitivity: 'base' })).forEach(entry => {
                const option = document.createElement('option'); option.value = entry.sessionId;
                option.textContent = `${codeOf(entry.shortCode)}${entry.remark ? ' · ' + String(entry.remark).trim() : ''}${entry.sessionId === recent ? ' · 最近使用' : ''}`;
                option.selected = entry.sessionId === recent; select.append(option);
            });
            document.getElementById('landingSessionPicker').hidden = false; recentButton.hidden = false;
        }
        landing.hidden = false;
    }
    start().catch(error => { landing.hidden = false; note.textContent = error.message; });
})();
