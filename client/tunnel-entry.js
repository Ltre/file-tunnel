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
    const t = value => window.TunnelI18n?.t(value) || value;
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
            let finished = false;
            const finish = (value,error) => { if (finished) return; finished=true; clearTimeout(timer); error?reject(error):resolve(value); };
            const timer = setTimeout(()=>finish(null,Error('database-timeout')),1200);
            const request = indexedDB.open('TunnelDB');
            let absent = false;
            request.onupgradeneeded = () => { absent = true; request.transaction.abort(); };
            request.onerror = () => absent ? finish({ sessions: [], shared: 0 }) : finish(null,request.error);
            request.onblocked = () => finish(null,Error('数据库正在使用'));
            request.onsuccess = () => {
                const db = request.result;
                if (finished) { db.close(); return; }
                const names = ['sessions', 'shareQueue'].filter(name => db.objectStoreNames.contains(name));
                if (!names.length) { db.close(); finish({ sessions: [], shared: 0 }); return; }
                const result = { sessions: [], shared: 0 };
                const tx = db.transaction(names, 'readonly');
                if (names.includes('sessions')) tx.objectStore('sessions').getAll().onsuccess = event => { result.sessions = event.target.result; };
                if (names.includes('shareQueue')) tx.objectStore('shareQueue').count().onsuccess = event => { result.shared = event.target.result; };
                tx.oncomplete = () => { db.close(); finish(result); };
                tx.onerror = () => { db.close(); finish(null,tx.error); };
            };
        });
    }
    async function routeFetch(url,options={}) {
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
        try { return await fetch(url,{...options,signal:controller.signal}); } finally {clearTimeout(timer);}
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
            response = await routeFetch('/api/tunnel-access', { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: JSON.stringify({ sessionId: id, deviceId, grant: auth.grant || '', shortCode, rejoin: true }) });
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
            const response = await routeFetch('/api/short-codes/' + encodeURIComponent(code), { cache: 'no-store' });
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
        const commitInput = event => {
            if (event.isComposing) return;
            input.value = codeOf(event.data || input.value).slice(-1);
            if (input.value && inputs[i + 1]) setTimeout(() => {
                if (document.activeElement === input) inputs[i + 1].focus();
            }, 0);
            const code = inputs.map(node => node.value).join('');
            if (codePattern.test(code)) join(code);
        };
        input.addEventListener('input', commitInput);
        input.addEventListener('compositionend', commitInput);
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
    document.getElementById('landingScanBtn').addEventListener('click', () => {
        window.TunnelCodeScanner.open(rawValue => {
            const raw=String(rawValue||'').trim();
            if (codePattern.test(raw.toUpperCase())) { fill(raw); return true; }
            try {
                const url=new URL(raw,location.origin);
                if (url.origin!==location.origin) return false;
                const code=url.searchParams.get('code')||url.searchParams.get('shortCode');
                if (code && codePattern.test(code.toUpperCase())) { fill(code); return true; }
                if (idPattern.test(url.hash.slice(1))) { url.searchParams.set('open','1');location.assign(url.href);return true; }
            } catch (_) {}
            return false;
        }).catch(error=>{ note.textContent=error.message; });
    });
    function renderSessions(entries) {
        sessions=[...new Map(entries.filter(entry=>idPattern.test(entry.sessionId||'')).map(entry=>[entry.sessionId,entry])).values()]
            .sort((a,b)=>(b.lastActive||0)-(a.lastActive||0));
        const selected=select.value,recent=sessions[0]?.sessionId;
        select.replaceChildren();
        sessions.slice().sort((a,b)=>a.sessionId.localeCompare(b.sessionId,undefined,{numeric:true,sensitivity:'base'})).forEach(entry=>{
            const option=document.createElement('option');option.value=entry.sessionId;
            option.dataset.i18nRaw='true';
            option.textContent=`${codeOf(entry.shortCode)||entry.sessionId.slice(0,8)}${entry.remark?' · '+String(entry.remark).trim():''}${entry.sessionId===recent?' · '+t('最近使用'):''}`;
            option.selected=entry.sessionId===(selected||recent);select.append(option);
        });
        landing.dataset.hasSessions=String(sessions.length>0);
        document.getElementById('landingSessionPicker').hidden=select.hidden=recentButton.hidden=!sessions.length;
    }
    async function start() {
        if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js').catch(() => {});
        const hash = location.hash.slice(1);
        if (/^[a-zA-Z0-9_-]{8,}$/.test(hash)) { openSession(hash, true); return; }
        renderSessions(storedDirectory());
        if (new URLSearchParams(location.search).has('leave') || !sessions.length) landing.hidden=false;
        let stored;
        try { stored = await readDatabase(); } catch (_) { landing.hidden=false;note.textContent=t('暂时无法读取浏览器数据库，已保留本机隧道列表。');return; }
        renderSessions(storedDirectory().length?storedDirectory():stored.sessions);
        if (!new URLSearchParams(location.search).has('leave') && !stored.shared && sessions.length) { openSession(sessions[0].sessionId, true); return; }
        if (stored.shared) { const notice = document.getElementById('sharedFilesNotice'); notice.hidden = false; notice.textContent = `已收到 ${stored.shared} 个分享文件，请选择要发送到的传输隧道。`; }
        landing.hidden = false;
    }
    window.addEventListener('drop2tunnel-language-changed',()=>renderSessions(sessions));
    start().catch(error => { landing.hidden = false; note.textContent = error.message; });
})();
