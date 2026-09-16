(function (global) {
    'use strict';
    const DB_NAME = 'TunnelWebWorkshop', DB_VERSION = 1, SANDBOX_TTL = 7 * 24 * 60 * 60 * 1000;
    let config = {}, overlay, content, dbPromise, activeDraft = null, saveTimer = 0, previewUrls = [], historyOpen = false;
    const textExtensions = /\.(?:html?|css|js|mjs|json|txt|md|svg|xml|csv|yaml|yml)$/i;

    function uid(prefix = 'web') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
    function safeName(value, fallback = 'web-page') { return String(value || fallback).trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\.html\.zip$/i, '') || fallback; }
    function normalizePath(value) {
        const path = String(value || '').replace(/\\/g, '/').split('/').filter(part => part && part !== '.' && part !== '..').join('/');
        if (!path) throw new Error('路径不能为空'); return path;
    }
    function resolveRelativePath(base, reference) {
        const result = String(base || '').split('/').filter(Boolean);
        for (const part of String(reference || '').replace(/\\/g, '/').split('/')) {
            if (!part || part === '.') continue;
            if (part === '..') result.pop(); else result.push(part);
        }
        return result.join('/');
    }
    function guessType(path) {
        const ext = path.split('.').pop()?.toLowerCase();
        return ({html:'text/html',htm:'text/html',css:'text/css',js:'text/javascript',mjs:'text/javascript',json:'application/json',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',mp3:'audio/mpeg',mp4:'video/mp4',txt:'text/plain',md:'text/markdown'})[ext] || 'application/octet-stream';
    }
    function openDb() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains('drafts')) request.result.createObjectStore('drafts', { keyPath:'id' });
                if (!request.result.objectStoreNames.contains('sandboxes')) request.result.createObjectStore('sandboxes', { keyPath:'id' });
            };
            request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        }); return dbPromise;
    }
    async function store(name, mode, operation) {
        const db = await openDb(); return new Promise((resolve, reject) => {
            const tx = db.transaction(name, mode); const result = operation(tx.objectStore(name));
            tx.oncomplete = () => resolve(result?.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
        });
    }
    const all = name => store(name, 'readonly', object => object.getAll());
    const get = (name, id) => store(name, 'readonly', object => object.get(id));
    const put = (name, value) => store(name, 'readwrite', object => object.put(value));
    const remove = (name, id) => store(name, 'readwrite', object => object.delete(id));
    function escapeHtml(value) { const node = document.createElement('div'); node.textContent = String(value || ''); return node.innerHTML; }
    function bytes(data) { return data instanceof Uint8Array ? data : new Uint8Array(data || 0); }
    function fileEntry(entry) { const data = bytes(entry.data); return { name:entry.path.split('/').pop(), path:entry.path, type:entry.type || guessType(entry.path), arrayBuffer:async () => data.slice().buffer }; }
    async function pack(files) { return global.FolderArchive.createZip(files.map(fileEntry)); }
    async function saveDraft(draft) {
        draft.updatedAt = Date.now(); draft.archive = await pack(draft.files); await put('drafts', draft); activeDraft = draft; return draft;
    }
    function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => saveDraft(activeDraft).catch(showError), 350); }
    function revokePreviewUrls() { previewUrls.forEach(url => URL.revokeObjectURL(url)); previewUrls = []; }
    function ensureUi() {
        if (overlay) return;
        overlay = document.createElement('section'); overlay.id = 'webWorkshop'; overlay.className = 'web-workshop'; overlay.hidden = true;
        overlay.innerHTML = `<header><button type="button" data-web-close aria-label="关闭">←</button><strong>网页工坊</strong><span></span><button type="button" data-web-home>草稿箱</button></header><main class="web-workshop-content"></main>`;
        document.body.append(overlay); content = overlay.querySelector('.web-workshop-content');
        overlay.querySelector('[data-web-close]').onclick = () => close(); overlay.querySelector('[data-web-home]').onclick = renderHome;
        document.addEventListener('keydown', event => { if (event.key === 'Escape' && overlay && !overlay.hidden) { event.preventDefault(); close(); } });
        window.addEventListener('popstate', () => { if (overlay && !overlay.hidden) close(true); });
    }
    function showError(error) { config.toast?.(error?.message || String(error)); }
    function open() { ensureUi(); overlay.hidden = false; overlay.classList.add('active'); if(!historyOpen){history.pushState({ ...(history.state || {}), webWorkshop:true }, '', location.href);historyOpen=true;} renderHome(); }
    function close(fromHistory = false) { if (!overlay) return; revokePreviewUrls(); overlay.hidden = true; overlay.classList.remove('active'); activeDraft = null; const shouldBack=historyOpen&&!fromHistory&&history.state?.webWorkshop;historyOpen=false;if(shouldBack)history.back(); }
    async function cleanupSandboxes() { for (const item of await all('sandboxes')) if (item.expiresAt <= Date.now()) await remove('sandboxes', item.id); }
    async function createDraft(source = {}) {
        const requestedName = source.name || prompt('网页名称', '我的网页'); if (!requestedName) return;
        const name = safeName(requestedName);
        const initial = source.files || [{ path:'index.html', type:'text/html', data:new TextEncoder().encode('<!doctype html>\n<html lang="zh-CN">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>我的网页</title></head>\n<body><h1>你好，网页工坊</h1></body>\n</html>') }];
        const draft = { id:uid('draft'), name, creatorDeviceId:config.deviceId?.() || '', sourceFileId:source.sourceFileId || '', sourceMessageId:source.sourceMessageId || '', sourceFileInfo:source.sourceFileInfo || null, publishMode:source.publishMode || 'new', files:initial.map(item => ({ ...item, data:bytes(item.data) })), createdAt:Date.now(), updatedAt:Date.now() };
        await saveDraft(draft); renderEditor(draft);
    }
    async function renderHome() {
        revokePreviewUrls(); activeDraft = null; await cleanupSandboxes();
        const drafts = (await all('drafts')).sort((a,b) => b.updatedAt-a.updatedAt);
        content.innerHTML = `<div class="web-workshop-toolbar"><button type="button" data-web-create>＋ 创建网页</button><label class="web-workshop-import">导入 .html.zip<input type="file" accept=".html.zip,application/zip" hidden></label></div><div class="web-draft-grid">${drafts.length ? drafts.map(draft => `<article data-draft-id="${draft.id}"><strong>${escapeHtml(draft.name)}</strong><small>${new Date(draft.updatedAt).toLocaleString()} · ${draft.files.length} 个文件</small><div><button data-action="edit">编辑</button><button data-action="preview">预览</button><button data-action="publish">发布</button><button data-action="delete">删除</button></div></article>`).join('') : '<p class="web-workshop-empty">草稿箱为空。创建网页后，所有修改会先保存在本机草稿缓存中。</p>'}</div>`;
        content.querySelector('[data-web-create]').onclick = () => createDraft().catch(showError);
        content.querySelector('input[type=file]').onchange = async event => {
            const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
            try { const entries = await global.FolderArchive.extractZip(file); await createDraft({ name:file.name, files:entries.map(entry => ({ ...entry, type:guessType(entry.path) })) }); } catch (error) { showError(error); }
        };
        content.querySelector('.web-draft-grid').onclick = async event => {
            const card = event.target.closest('[data-draft-id]'), action = event.target.dataset.action; if (!card || !action) return;
            const draft = await get('drafts', card.dataset.draftId); if (!draft) return;
            if (action === 'edit') renderEditor(draft);
            if (action === 'preview') renderPreview(draft.files, draft.name, () => renderEditor(draft));
            if (action === 'publish') publishDraft(draft).catch(showError);
            if (action === 'delete' && confirm(`确定删除草稿“${draft.name}”吗？`)) { await remove('drafts', draft.id); renderHome(); }
        };
    }
    function isText(entry) { return String(entry.type || '').startsWith('text/') || textExtensions.test(entry.path); }
    async function renderEditor(draft, selectedPath = '') {
        activeDraft = draft; revokePreviewUrls();
        let selected = draft.files.find(file => file.path === selectedPath) || draft.files.find(file => /(^|\/)index\.html?$/i.test(file.path)) || draft.files.find(isText);
        content.innerHTML = `<div class="web-editor-toolbar"><button data-editor-action="upload">上传资源</button><button data-editor-action="new-file">新建文件</button><button data-editor-action="new-dir">新建目录</button><button data-editor-action="rename">重命名</button><button data-editor-action="delete">删除</button><span></span><button data-editor-action="preview">预览</button><button class="primary" data-editor-action="publish">发布草稿</button><input type="file" multiple hidden></div><div class="web-editor"><aside>${draft.files.slice().sort((a,b)=>a.path.localeCompare(b.path)).map(file => `<button type="button" class="${selected?.path === file.path ? 'active':''}" data-web-path="${escapeHtml(file.path)}">${file.path.endsWith('/')?'📁':'📄'} ${escapeHtml(file.path)}</button>`).join('')}</aside><section>${selected && isText(selected) ? `<label>${escapeHtml(selected.path)}</label><textarea spellcheck="false"></textarea>` : `<div class="web-editor-binary">${selected ? `${escapeHtml(selected.path)}<br>${bytes(selected.data).byteLength} Bytes` : '请选择文件'}</div>`}</section></div>`;
        const textarea = content.querySelector('textarea'); if (textarea) { textarea.value = new TextDecoder().decode(bytes(selected.data)); textarea.oninput = () => { selected.data = new TextEncoder().encode(textarea.value); scheduleSave(); }; }
        content.querySelector('aside').onclick = event => { const button=event.target.closest('[data-web-path]'); if (button) renderEditor(draft, button.dataset.webPath); };
        const input = content.querySelector('input[type=file]'); input.onchange = async event => { for (const file of event.target.files || []) { const path=normalizePath(file.webkitRelativePath || file.name); const entry={path,type:file.type||guessType(path),data:new Uint8Array(await file.arrayBuffer())}; const index=draft.files.findIndex(item=>item.path===path); if(index>=0)draft.files[index]=entry;else draft.files.push(entry); } await saveDraft(draft); renderEditor(draft, selected?.path); };
        content.querySelector('.web-editor-toolbar').onclick = async event => {
            const action=event.target.dataset.editorAction; if(!action)return;
            if(action==='upload') input.click();
            if(action==='new-file'){const path=prompt('新文件路径','index.html');if(path){const normalized=normalizePath(path);draft.files.push({path:normalized,type:guessType(normalized),data:new Uint8Array()});await saveDraft(draft);renderEditor(draft,normalized);}}
            if(action==='new-dir'){const path=prompt('新目录路径','assets');if(path){const normalized=normalizePath(path)+'/';if(!draft.files.some(item=>item.path===normalized))draft.files.push({path:normalized,type:'application/x-directory',data:new Uint8Array()});await saveDraft(draft);renderEditor(draft,normalized);}}
            if(action==='rename'&&selected){const path=prompt('新路径',selected.path.replace(/\/$/,''));if(path){const normalized=normalizePath(path)+(selected.path.endsWith('/')?'/':'');const old=selected.path;if(old.endsWith('/'))draft.files.forEach(item=>{if(item.path.startsWith(old))item.path=normalized+item.path.slice(old.length);});else selected.path=normalized;selected.type=guessType(normalized);await saveDraft(draft);renderEditor(draft,normalized);}}
            if(action==='delete'&&selected&&confirm(`确定删除 ${selected.path} 吗？`)){const path=selected.path;draft.files=draft.files.filter(item=>item.path!==path&&!item.path.startsWith(path.endsWith('/')?path:path+'/'));await saveDraft(draft);renderEditor(draft);}
            if(action==='preview')renderPreview(draft.files,draft.name,()=>renderEditor(draft,selected?.path));
            if(action==='publish')publishDraft(draft).catch(showError);
        };
    }
    function renderPreview(files, name, back, extraActions = '') {
        revokePreviewUrls(); const map = new Map();
        for (const item of files.filter(file => !file.path.endsWith('/'))) { const url=URL.createObjectURL(new Blob([bytes(item.data)],{type:item.type||guessType(item.path)}));previewUrls.push(url);map.set(item.path,url); }
        for (const item of files.filter(file => /\.css$/i.test(file.path))) {
            const base=item.path.includes('/')?item.path.slice(0,item.path.lastIndexOf('/')+1):'';
            const css=new TextDecoder().decode(bytes(item.data)).replace(/url\(\s*(['"]?)(?![a-z]+:|\/\/|#)([^)'"\s]+)\1\s*\)/gi,(whole,quote,ref)=>{const url=map.get(resolveRelativePath(base,ref.split(/[?#]/)[0]));return url?`url("${url}")`:whole;});
            const url=URL.createObjectURL(new Blob([css],{type:'text/css'}));previewUrls.push(url);map.set(item.path,url);
        }
        const entry=files.find(file=>/(^|\/)index\.html?$/i.test(file.path))||files.find(file=>/\.html?$/i.test(file.path));
        if(!entry){showError(new Error('网页 ZIP 中没有 HTML 入口文件'));return;}
        let html=new TextDecoder().decode(bytes(entry.data)); const base=entry.path.includes('/')?entry.path.slice(0,entry.path.lastIndexOf('/')+1):'';
        html=html.replace(/\b(src|href)=(['"])(?![a-z]+:|\/\/|#)([^'"]+)\2/gi,(whole,attr,quote,ref)=>{const parts=ref.split(/[?#]/);const resolved=resolveRelativePath(base,parts[0]);const url=map.get(resolved);return url?`${attr}=${quote}${url}${quote}`:whole;});
        content.innerHTML=`<div class="web-preview-toolbar"><button data-preview-back>← 返回</button><strong>${escapeHtml(name)}</strong><span></span>${extraActions}</div><iframe class="web-preview-frame" sandbox="allow-scripts allow-forms allow-modals" referrerpolicy="no-referrer"></iframe>`;
        content.querySelector('iframe').srcdoc=html; content.querySelector('[data-preview-back]').onclick=back;
    }
    async function publishDraft(draft) {
        await saveDraft(draft); const file=new File([draft.archive],`${safeName(draft.name)}.html.zip`,{type:'application/zip'});
        const mayUpdate=draft.publishMode==='update'&&draft.sourceFileId&&config.canUpdate?.(draft.sourceFileInfo);
        const fileId=mayUpdate?await config.publishUpdate(file,draft):await config.publishNew(file,{webZip:true,creatorDeviceId:config.deviceId?.()||'',webZipDraftId:draft.id});
        if(!fileId)throw new Error('网页发布失败'); await remove('drafts',draft.id); close(); config.focusFile?.(fileId); config.toast?.(mayUpdate?'网页 ZIP 已更新':'网页 ZIP 已发送到隧道');
    }
    async function openPackage(fileInfo, blob, context = {}) {
        ensureUi(); await cleanupSandboxes(); const sandboxId=`sandbox:${fileInfo.id}`; let sandbox=await get('sandboxes',sandboxId);
        if(!sandbox||sandbox.expiresAt<=Date.now()||sandbox.size!==blob.size){const entries=await global.FolderArchive.extractZip(blob);sandbox={id:sandboxId,fileId:fileInfo.id,size:blob.size,files:entries.map(entry=>({...entry,type:guessType(entry.path)})),createdAt:Date.now(),expiresAt:Date.now()+SANDBOX_TTL};await put('sandboxes',sandbox);}
        overlay.hidden=false;overlay.classList.add('active');if(!historyOpen){history.pushState({...(history.state||{}),webWorkshop:true},'',location.href);historyOpen=true;}
        const canUpdate=config.canUpdate?.(fileInfo); const actions=`<button data-sandbox-copy>创建我的副本</button>${canUpdate?'<button class="primary" data-sandbox-edit>转入草稿编辑</button>':'<button data-sandbox-request>申请编辑权限</button>'}`;
        renderPreview(sandbox.files,fileInfo.name,renderHome,actions);
        content.querySelector('[data-sandbox-copy]').onclick=()=>createDraft({name:fileInfo.name,files:sandbox.files,publishMode:'new'}).catch(showError);
        content.querySelector('[data-sandbox-edit]')?.addEventListener('click',()=>createDraft({name:fileInfo.name,files:sandbox.files,sourceFileId:fileInfo.id,sourceMessageId:context.messageId||'',sourceFileInfo:fileInfo,publishMode:'update'}).catch(showError));
        content.querySelector('[data-sandbox-request]')?.addEventListener('click',()=>config.requestEdit?.(fileInfo,context));
    }
    function init(next = {}) { config=next;ensureUi();cleanupSandboxes().catch(()=>{}); }
    global.WebWorkshop={init,open,close,openPackage,createDraft};
})(window);
