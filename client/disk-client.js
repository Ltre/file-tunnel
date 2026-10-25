'use strict';
// Browser transport for the standalone drive. The UI and integrations share jobs.
(function () {
    const base = '/api/telegram/drive';
    let collaborationId = '', mountId = '';
    let diskSpace = '';
    let accountId = '';
    const baseUrl = () => mountId ? base + '/mount-scope/' + encodeURIComponent(mountId) : collaborationId ? base + '/collaboration-scope/' + encodeURIComponent(collaborationId) : base;
    const transportContext=()=>({requestBase:baseUrl(),diskSpace,accountId});
    const operationContexts=new Map();
    const withSpace = (url, requestSpace = diskSpace) => {
        if (!requestSpace) return url;
        const address = new URL(url, location.origin);
        address.searchParams.set('disk_space', requestSpace);
        return address.pathname + address.search + address.hash;
    };
    const withAccount = (url, value = accountId) => {
        if (!value) return url;
        const address = new URL(url, location.origin); address.searchParams.set('disk_account', value);
        return address.pathname + address.search + address.hash;
    };
    const accountHeaders = (value = accountId) => value ? { 'X-Disk-Account': value } : {};
    const sortJobs = values => window.DiskOperationOrder?.sort(values) || values.slice().sort((a, b) =>
        Math.max(Number(b.createdAt) || 0, Number(b.startedAt) || 0, Number(b.finishedAt) || 0)
        - Math.max(Number(a.createdAt) || 0, Number(a.startedAt) || 0, Number(a.finishedAt) || 0)
        || String(a.operation_id || '').localeCompare(String(b.operation_id || '')));
    const listeners = new Set();
    const terminalListeners = new Set();
    const localUploads = new Map();
    const uploadSession = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    let deviceId = uploadSession;
    try { deviceId = localStorage.getItem('disk-device-id') || uploadSession; localStorage.setItem('disk-device-id', deviceId); } catch (_) {}
    const pendingReads = new Map();
    const readContexts = new Map();
    const uploadControllers = new Map();
    const uploadProgressStreams = new Map();
    const readControllers = new Map();
    const hiddenLoadingOperations = new Set();
    const cacheProgressByFile = new Map();
    let streamSequence = 0;
    const newAbortController = () => typeof AbortController === 'function' ? new AbortController() : { signal: { aborted: false, addEventListener() {} }, abort() { this.signal.aborted = true; } };
    const abortError = () => { const error = new Error('OPERATION_CANCELLED'); error.name = 'AbortError'; return error; };
    const cacheChanged = () => { if (typeof CustomEvent !== 'undefined') window.dispatchEvent?.(new CustomEvent('disk-cache-changed')); };
    const cacheKey = (id, context = transportContext()) => (context.accountId || '') + ':' + id;
    const setCacheProgress = (id, value, context) => {
        const key = cacheKey(id, context), previous = cacheProgressByFile.get(key);
        if (value) cacheProgressByFile.set(key, value); else cacheProgressByFile.delete(key);
        if (!previous || !value || previous.phase !== value.phase || Math.floor(previous.percent ?? -1) !== Math.floor(value.percent ?? -1)) cacheChanged();
    };
    let uploadSequence = 0;
    let jobs = [], polling = null, generation = 0, enabled = false, lastRefresh = 0;
    const viewOperationIds = new Set();
    const contextKey = context => (context.accountId || '') + ':' + context.requestBase + '?' + (context.diskSpace || '');
    const belongsToView = job => viewOperationIds.has(job.operation_id)
        || localUploads.has(job.operation_id) && contextKey(operationContexts.get(job.operation_id) || transportContext()) === contextKey(transportContext());
    const waiting = new Map();
    const activities = new Set(), activityListeners = new Set();
    const emitActivities = () => activityListeners.forEach(listener => listener([...activities].filter(activity => activity.accountId === accountId)));
    async function withActivity(message, run) {
        const activity = typeof message === 'object' ? { accountId, ...message, operationId: message.operationId || '' } : { accountId, message, operationId: '' };
        activities.add(activity); emitActivities();
        const update = values => { Object.assign(activity, values); emitActivities(); };
        try { return await run(update); }
        finally { activities.delete(activity); emitActivities(); }
    }
    const active = job => ['queued', 'running'].includes(job.status);
    function localAccountOperations(identity) {
        const found=new Map(); let index=0;
        for(const job of [...jobs,...localUploads.values()]) if(active(job)&&(job.userId===identity || operationContexts.get(job.operation_id)?.accountId===identity)) found.set(job.operation_id,job.accountSwitchTitle?{...job,title:job.accountSwitchTitle}:job);
        for(const activity of activities) if(activity.accountId===identity&&!found.has(activity.operationId)) { const id=activity.operationId||uploadSession+':activity-'+(++index); found.set(id,{operation_id:id,type:'read',status:'running',title:activity.message}); }
        return [...found.values()];
    }
    const accountActivityQueries=new Map();let accountActivityChannel,accountActivitySequence=0;
    function connectAccountActivityChannel() {
        if(accountActivityChannel || typeof BroadcastChannel!=='function')return;
        try {
            accountActivityChannel=new BroadcastChannel('drop2tunnel-disk-account-activity');
            accountActivityChannel.onmessage=event=>{
                const data=event.data;if(!data||typeof data.requestId!=='string'||typeof data.accountId!=='string')return;
                if(data.type==='query') {
                    const operations=localAccountOperations(data.accountId).map(job=>({operation_id:job.operation_id,type:job.type,status:job.status,title:job.title||job.message||'',historyMirrorId:job.historyMirrorId}));
                    accountActivityChannel?.postMessage({type:'reply',requestId:data.requestId,accountId:data.accountId,operations});
                } else if(data.type==='reply') {
                    const query=accountActivityQueries.get(data.requestId);
                    if(query?.accountId===data.accountId&&Array.isArray(data.operations))query.operations.push(...data.operations.filter(job=>job&&typeof job.operation_id==='string'&&active(job)));
                }
            };
        } catch(_) { accountActivityChannel=null; }
    }
    connectAccountActivityChannel();
    window.addEventListener?.('pagehide',()=>{accountActivityChannel?.close();accountActivityChannel=null;});
    window.addEventListener?.('pageshow',connectAccountActivityChannel);
    function peerAccountOperations(identity) {
        if(!accountActivityChannel)return Promise.resolve([]);
        return new Promise(resolve=>{
            const requestId=uploadSession+':'+(++accountActivitySequence),query={accountId:identity,operations:[]};
            accountActivityQueries.set(requestId,query);
            const finish=()=>{accountActivityQueries.delete(requestId);resolve(query.operations);};
            const timer=setTimeout(finish,150);
            try { accountActivityChannel.postMessage({type:'query',requestId,accountId:identity}); }
            catch(_) { clearTimeout(timer);finish(); }
        });
    }
    const clientProgressFields = ['clientBytesReceived', 'clientTotalBytes', 'clientBytesPerSecond', 'clientFileIndex', 'clientFileCount', 'clientFileName', 'clientFileSize', 'clientPartIndex', 'clientPartCount'];
    const visibleJobs = () => sortJobs([...localUploads.values()].filter(job => belongsToView(job) && !jobs.some(remote => remote.operation_id === job.operation_id && (job.status !== 'failed' || !active(remote))))
        .concat(jobs.filter(job => belongsToView(job) && (localUploads.get(job.operation_id)?.status !== 'failed' || !active(job))).map(job => {
            const local = localUploads.get(job.operation_id);
            if (!local || !active(job)) return job;
            const progress = Object.fromEntries(clientProgressFields.filter(key => local[key] !== undefined).map(key => [key, local[key]]));
            if (Number.isFinite(progress.clientBytesReceived)) progress.clientBytesReceived = Math.max(progress.clientBytesReceived, Number(job.clientBytesReceived) || 0);
            return { ...job, ...progress };
        })).filter(job => job.type==='transfer-history' && active(job)
            ? !jobs.some(source => source.historyMirrorId===job.operation_id && active(source))
            : !job.historyMirrorId || active(job) || !jobs.some(mirror => mirror.operation_id===job.historyMirrorId)));
    const emit = () => {
        // Upload failure detection must continue outside the current UI view.
        terminalListeners.forEach(listener => listener(jobs));
        listeners.forEach(listener => listener(visibleJobs()));
    };
    function uploadBody(url, options) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest(), signal = options.signal;
            let settled = false;
            const finish = (error, value) => {
                if (settled) return; settled = true;
                signal?.removeEventListener?.('abort', abort);
                error ? reject(error) : resolve(value);
            };
            const abort = () => { xhr.abort(); finish(abortError()); };
            const progress = loaded => { try { options.onUploadProgress(loaded); } catch (error) { finish(error); xhr.abort(); } };
            xhr.upload.addEventListener('progress', event => {
                if (settled || signal?.aborted) return;
                progress(Math.min(Number(options.body?.size) || 0, event.loaded));
            });
            xhr.addEventListener('load', () => {
                let data = {}; try { data = JSON.parse(xhr.responseText || '{}'); } catch (_) {}
                if (xhr.status < 200 || xhr.status >= 300) {
                    const error = Object.assign(new Error(data.error || 'DISK_REQUEST_FAILED'), data, { status: xhr.status }); finish(error); return;
                }
                progress(Number(options.body?.size) || 0); finish(null, data);
            });
            xhr.addEventListener('error', () => finish(Object.assign(new Error('Failed to fetch'), { transportFailure: true })));
            xhr.addEventListener('timeout', () => finish(Object.assign(new Error('UPLOAD_CLIENT_TIMEOUT'), { transportFailure: true })));
            xhr.addEventListener('abort', () => finish(abortError()));
            xhr.open(options.method || 'PUT', url, true); xhr.withCredentials = true;
            for (const [key, value] of Object.entries({ ...options.headers, ...accountHeaders(options.accountId), 'X-Disk-Device-Id': deviceId })) xhr.setRequestHeader(key, value);
            signal?.addEventListener?.('abort', abort, { once: true });
            if (signal?.aborted) return abort();
            try { xhr.send(options.body); } catch (error) { error.transportFailure = true; finish(error); }
        });
    }
    async function raw(url, options = {}) {
        const requestAccount = options.accountId ?? accountId;
        const method = String(options.method || 'GET').toUpperCase();
        // Legacy UI callers pass full drive API paths. Treat them exactly as
        // relative paths, so mounted edits cannot silently use the native drive.
        if (url.startsWith(base + '/')) url = url.slice(base.length);
        const globalRoute = /^\/(?:me|accounts|spaces|collaborations|mounts|collaboration-scope|mount-scope|static-resources|settings|cross-scope|trash)(?:[/?]|$)/.test(url)
            || method !== 'POST' && /^\/shares(?:[/?]|$)/.test(url);
        const target = withSpace(url.startsWith('/api/') ? url : (globalRoute ? base : (options.requestBase || baseUrl())) + url, options.diskSpace ?? diskSpace);
        if (options.onUploadProgress && typeof XMLHttpRequest === 'function') return uploadBody(target, { ...options, accountId: requestAccount });
        const { onUploadProgress, diskSpace: requestSpace,requestBase, accountId: requestedAccount, ...requestOptions } = options;
        let response;
        try { response = await fetch(target, { credentials: 'same-origin', cache: method === 'GET' ? 'no-store' : 'no-cache', ...requestOptions, headers: { ...options.headers, ...accountHeaders(requestAccount), 'X-Disk-Device-Id': deviceId } }); }
        catch (error) { error.transportFailure = true; throw error; }
        const data = await response.json().catch(() => ({}));
        // Cross-namespace transfers return their committed result directly,
        // without an operation_id for request()/wait() to observe. Refresh
        // source-view histories for raw callers too, including failed attempts.
        // An in-flight poll may predate this mutation and must finish first.
        if (method === 'POST' && /^\/(?:cross-scope\/(?:copy|move)|spaces\/transfer)(?:\?|$)/.test(url)) {
            const updateHistory = () => refresh(true);
            (polling ? polling.then(updateHistory, updateHistory) : updateHistory()).catch(() => {});
        }
        if (!response.ok) { const error = new Error(data.error || 'DISK_REQUEST_FAILED'); Object.assign(error, data); error.status = response.status; throw error; }
        onUploadProgress?.(Number(options.body?.size) || 0);
        return data;
    }
    function mergeOperation(next) {
        const previous = jobs.find(job => job.operation_id === next.operation_id);
        if (previous && !active(previous) && active(next)) return previous;
        if (Number.isFinite(previous?.updatedAt) && Number.isFinite(next.updatedAt) && next.updatedAt < previous.updatedAt) return previous;
        const merged = { ...previous, ...next };
        if (Number.isFinite(previous?.clientBytesReceived) && Number.isFinite(next.clientBytesReceived)) merged.clientBytesReceived = Math.max(previous.clientBytesReceived, next.clientBytesReceived);
        if (merged.type === 'upload' && active(merged) && Number.isFinite(merged.telegramBytesSent) && merged.telegramTotalBytes > 0) merged.percent = Math.min(99, merged.telegramBytesSent / merged.telegramTotalBytes * 100);
        return merged;
    }
    function subscribeUploadProgress(job,context=transportContext()) {
        if (!job.progressive || typeof EventSource !== 'function') return () => {};
        let stream; try { stream = new EventSource(withAccount(withSpace(context.requestBase + '/uploads/' + encodeURIComponent(job.uploadId) + '/progress',context.diskSpace), context.accountId)); } catch (_) { return () => {}; }
        uploadProgressStreams.set(job.operation_id, stream);
        const close = () => { stream.close(); if (uploadProgressStreams.get(job.operation_id) === stream) uploadProgressStreams.delete(job.operation_id); };
        stream.addEventListener('progress', event => {
            if (uploadProgressStreams.get(job.operation_id) !== stream) return;
            let operation; try { operation = JSON.parse(event.data); } catch (_) { return; }
            if (operation?.operation_id !== job.operation_id) return;
            operation = mergeOperation(operation);
            jobs = sortJobs(jobs.filter(item => item.operation_id !== operation.operation_id).concat(operation));
            if(contextKey(context)===contextKey(transportContext()))viewOperationIds.add(operation.operation_id);
            if (!active(operation)) {
                hiddenLoadingOperations.delete(operation.operation_id); localUploads.delete(operation.operation_id);
                const pending = waiting.get(operation.operation_id);
                if (pending) {
                    waiting.delete(operation.operation_id);
                    if (operation.status === 'completed') pending.resolve(operation.result);
                    else pending.reject(Object.assign(new Error(operation.status === 'cancelled' ? 'OPERATION_CANCELLED' : operation.errorCode || 'DISK_OPERATION_FAILED'), { errorDetails: operation.errorDetails, userMessage: operation.errorMessage, partialItems: operation.result?.partialItems }));
                }
                close();
            }
            emit();
        });
        stream.addEventListener('error', () => { if (uploadProgressStreams.get(job.operation_id) === stream) refresh(true); });
        return close;
    }
    async function refresh(force = false) {
        if (!enabled) return;
        if (polling) return polling;
        if (!force && Date.now() - lastRefresh < 1800) return;
        const current = generation; lastRefresh = Date.now();
        const requested = new Set(waiting.keys());
        const contexts=new Map(),view=transportContext();
        const add=context=>contexts.set(contextKey(context),context);
        add(view);for(const handlers of waiting.values())add(handlers.context);
        for(const id of localUploads.keys())if(operationContexts.has(id))add(operationContexts.get(id));
        polling = Promise.allSettled([...contexts.values()].map(async context=>{
            const ids=[...requested].filter(id=>contextKey(waiting.get(id)?.context || transportContext()) === contextKey(context));
            const data=await raw('/operations?ids='+encodeURIComponent(ids.join(',')),context);
            return {context,operations:data.operations||[]};
        })).then(results=>{
            if(current!==generation)return;
            const values=results.filter(r=>r.status==='fulfilled').map(r=>r.value),visible=values.find(value=>contextKey(value.context)===contextKey(transportContext()));
            if(visible){viewOperationIds.clear();for(const job of visible.operations)viewOperationIds.add(job.operation_id);}
            // Poll every pending context so its promise can settle, but render
            // only records returned for the currently selected source view.
            jobs=sortJobs([...new Map(values.flatMap(value=>value.operations).map(job=>[job.operation_id,mergeOperation(job)])).values()]);
            for(const job of jobs)if(!active(job))hiddenLoadingOperations.delete(job.operation_id);
            for(const id of localUploads.keys())if(jobs.some(j=>j.operation_id===id&&!active(j)))localUploads.delete(id);
            for(const [id,handlers] of waiting){
                const job=jobs.find(item=>item.operation_id===id);
                if(!job||active(job)||!requested.has(id))continue;
                waiting.delete(id);
                if(job.status==='completed')handlers.resolve(job.result);
                else handlers.reject(Object.assign(new Error(job.status==='cancelled'?'OPERATION_CANCELLED':job.errorCode||'DISK_OPERATION_FAILED'),{partialItems:job.result?.partialItems,errorDetails:job.errorDetails,userMessage:job.errorMessage}));
            }
            for(let index=0;index<results.length;index++)if(results[index].status==='rejected'&&results[index].reason?.message==='LOGIN_REQUIRED'){
                const failedContext=[...contexts.values()][index];
                for(const [id,handlers] of waiting)if(contextKey(handlers.context)===contextKey(failedContext)){handlers.reject(results[index].reason);waiting.delete(id);}
            }
            emit();
        }).finally(()=>{polling=null;});
        return polling;
    }
    async function wait(id,context=operationContexts.get(id)||transportContext()) {
        enabled = true;
        if (waiting.has(id)) return waiting.get(id).promise;
        const pending = {context};operationContexts.set(id,context);
        pending.promise = new Promise((resolve, reject) => { pending.resolve = resolve; pending.reject = reject; });
        waiting.set(id, pending);
        if (polling) polling.finally(() => { if (waiting.has(id)) refresh(true); });
        else refresh(true);
        return pending.promise;
    }
    async function performRequest(url, options, update) {
        const context={...transportContext(),...options};
        const data = await raw(url, context);
        if(data.operation_id)operationContexts.set(data.operation_id,{requestBase:context.requestBase,diskSpace:context.diskSpace,accountId:context.accountId});
        if (data.operation_id) update?.({ operationId: data.operation_id });
        if (data.operation_id && !data.uploadId && data.status === 'completed') {
            refresh(true);
            return data.result;
        }
        return data.operation_id && !data.uploadId ? wait(data.operation_id,{requestBase:context.requestBase,diskSpace:context.diskSpace,accountId:context.accountId}) : data;
    }
    function request(url, options = {}) {
        const method = String(options.method || 'GET').toUpperCase();
        let body = {}; try { body = JSON.parse(options.body || '{}'); } catch (_) {}
        const target = url.includes('/directories') ? '目录' : '文件';
        const message = url.endsWith('/task-saves') ? '正在转存到网盘'
            : url.includes('/shares') ? (method === 'DELETE' ? '正在停止分享' : method === 'POST' ? '正在创建分享' : '正在加载分享列表')
            : method === 'DELETE' ? '正在删除' + target
            : method === 'PATCH' ? ('folderPath' in body || 'destinationPath' in body ? '正在移动' : '正在重命名') + target
            : url.endsWith('/check') ? '正在检测文件可用性'
            : url.endsWith('/repair') ? '正在修复文件'
            : method === 'POST' && target === '目录' ? '正在创建目录'
            : url.includes('/list') ? '正在加载文件列表' : '正在读取网盘信息';
        return withActivity(message, update => performRequest(url, options, update));
    }
    const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    function start() { enabled = true; refresh(); }
    function stop() {
        enabled = false; generation++; jobs = []; viewOperationIds.clear(); localUploads.clear();
        for(const controller of uploadControllers.values())controller.abort();
        for(const readers of pendingReads.values())for(const controller of readers)controller.abort();
        for (const stream of uploadProgressStreams.values()) stream.close(); uploadProgressStreams.clear();
        hiddenLoadingOperations.clear(); cacheProgressByFile.clear();
        for (const handlers of waiting.values()) handlers.reject(new Error('LOGIN_REQUIRED'));
        waiting.clear();operationContexts.clear();emit();
    }
    function stopAccount(id) {
        const selected = String(id || '');
        for (const [operationId, context] of operationContexts) {
            if ((context.accountId || '') !== selected) continue;
            uploadControllers.get(operationId)?.abort(); readControllers.get(operationId)?.abort();
            uploadProgressStreams.get(operationId)?.close(); uploadProgressStreams.delete(operationId);
            const handlers = waiting.get(operationId); if (handlers) handlers.reject(new Error('LOGIN_REQUIRED'));
            waiting.delete(operationId); localUploads.delete(operationId); hiddenLoadingOperations.delete(operationId);
            viewOperationIds.delete(operationId);
        }
        for (const [controller, context] of readContexts) if ((context.accountId || '') === selected) controller.abort();
        emit(); emitActivities();
    }
    // One batched poll for all jobs; idle home pages do not keep polling every second.
    setInterval(() => {
        const interval = waiting.size || jobs.some(active) ? 2400 : 60000;
        if (enabled && Date.now() - lastRefresh >= interval) refresh();
    }, 800);
    function upload(files, folderPath, read = file => file, metadata = {}) {
        const uploadContext = { ...(metadata.transportContext || transportContext()) };
        return withActivity({ message: '正在上传 ' + files.length + ' 个文件', accountId: uploadContext.accountId || '' }, async update => {
            // Also keep failures before the server can create a task (offline/HTTP errors).
            const createdAt = Date.now();
            const pending = { operation_id: 'local-upload-' + uploadSession + '-' + ++uploadSequence, type: 'upload', status: 'queued', phase: 'preparing', message: '正在准备上传', title: '上传 ' + files.length + ' 个文件', folderPath: String(folderPath || ''), percent: null, createdAt, startedAt: createdAt, updatedAt: createdAt };
            pending.accountSwitchTitle = pending.title + '：' + files[0]?.name;
            const controller = newAbortController();
            const current = generation,context=uploadContext;operationContexts.set(pending.operation_id,context);
            localUploads.set(pending.operation_id, pending); uploadControllers.set(pending.operation_id, controller); emit(); update({ operationId: pending.operation_id });
            try {
                return await uploadFiles(files, folderPath, read, metadata, values => {
                    if (current !== generation) throw new Error('LOGIN_REQUIRED');
                    if (values.operationId && values.operationId !== pending.operation_id) {
                        const previousId = pending.operation_id;
                        localUploads.delete(previousId); uploadControllers.delete(previousId);
                        pending.operation_id = values.operationId;operationContexts.set(pending.operation_id,context); localUploads.set(pending.operation_id, pending); uploadControllers.set(pending.operation_id, controller);
                        if (hiddenLoadingOperations.delete(previousId)) hiddenLoadingOperations.add(pending.operation_id);
                    }
                    for (const key of clientProgressFields) if (values[key] !== undefined) pending[key] = values[key];
                    pending.updatedAt = Date.now();
                    if (pending.operation_id.startsWith('local-upload-')) {
                        for (const key of ['phase','message','percent','hashedBytes','hashTotalBytes'])
                            if (values[key] !== undefined) pending[key] = values[key];
                    }
                    update(values); emit();
                }, controller.signal,context);
            } catch (error) {
                if (current === generation && !jobs.some(job => job.operation_id === pending.operation_id && !active(job))) {
                    const cancelled = controller.signal.aborted || error.message === 'OPERATION_CANCELLED';
                    Object.assign(pending, { status: cancelled ? 'cancelled' : 'failed', phase: cancelled ? 'cancelled' : 'failed', message: cancelled ? '用户已取消任务' : '上传请求失败', errorCode: cancelled ? '' : error.message, finishedAt: Date.now(), updatedAt: Date.now() });
                    localUploads.set(pending.operation_id, pending);
                }
                throw error;
            } finally {
                uploadControllers.delete(pending.operation_id);
                if (pending.status !== 'failed') localUploads.delete(pending.operation_id);
                emit();
            }
        });
    }
    const withSignal = (options, signal) => ({ ...options, signal });
    const delay = (ms, signal) => new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(abortError());
        const abort = () => { clearTimeout(timer); signal?.removeEventListener?.('abort', abort); reject(abortError()); };
        const timer = setTimeout(() => { signal?.removeEventListener?.('abort', abort); resolve(); }, ms);
        signal?.addEventListener('abort', abort, { once: true });
    });
    const inferredType = file => {
        if (file.type) return file.type;
        const ext = String(file.name || '').toLowerCase().split('.').pop();
        return ({ mp4:'video/mp4', webm:'video/webm', mov:'video/quicktime', m4v:'video/mp4', mp3:'audio/mpeg', m4a:'audio/mp4', aac:'audio/aac', ogg:'audio/ogg', opus:'audio/ogg', wav:'audio/wav', flac:'audio/flac', jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp', avif:'image/avif', svg:'image/svg+xml', pdf:'application/pdf', txt:'text/plain' })[ext] || 'application/octet-stream';
    };
    let audioCoverExtractor = null;
    async function createAudioUploadThumbnail(blob, file) {
        if (!audioCoverExtractor) return null;
        const source = await audioCoverExtractor(blob, file);
        if (!source) return null;
        const image = new Image();
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { image.onload = image.onerror = null; reject(new Error('AUDIO_THUMBNAIL_TIMEOUT')); }, 12000);
            image.onload = () => { clearTimeout(timer); image.onload = image.onerror = null; resolve(); };
            image.onerror = () => { clearTimeout(timer); image.onload = image.onerror = null; reject(new Error('AUDIO_THUMBNAIL_DECODE_FAILED')); };
            image.src = source;
        });
        if (!image.naturalWidth || !image.naturalHeight) return null;
        const scale = Math.min(1, 480 / image.naturalWidth, 480 / image.naturalHeight);
        const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext('2d'); if (!context) return null;
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .82));
    }
    async function createUploadThumbnail(blob, file) {
        const type = inferredType(file);
        if (!/^(video|audio)\//.test(type) || typeof Blob === 'undefined' || !(blob instanceof Blob)) return null;
        if (type.startsWith('audio/')) return createAudioUploadThumbnail(blob, { ...file, type });
        const video = document.createElement('video'), source = URL.createObjectURL(blob);
        video.muted = true; video.playsInline = true; video.preload = 'metadata';
        const wait = (names, timeout = 12000) => new Promise((resolve, reject) => {
            const finish = event => { cleanup(); event.type === 'error' ? reject(new Error('VIDEO_THUMBNAIL_DECODE_FAILED')) : resolve(); };
            const cleanup = () => { clearTimeout(timer); for (const name of [...names, 'error']) video.removeEventListener(name, finish); };
            const timer = setTimeout(() => { cleanup(); reject(new Error('VIDEO_THUMBNAIL_TIMEOUT')); }, timeout);
            for (const name of [...names, 'error']) video.addEventListener(name, finish, { once: true });
        });
        try {
            const ready = wait(['loadedmetadata']); video.src = source; await ready;
            if (Number.isFinite(video.duration) && video.duration > .2) {
                const seeked = wait(['seeked']); video.currentTime = Math.min(2, Math.max(.1, video.duration * .08)); await seeked;
            }
            if (video.readyState < 2) await wait(['loadeddata']);
            const width = Number(video.videoWidth), height = Number(video.videoHeight);
            if (!width || !height) return null;
            const scale = Math.min(1, 480 / width, 360 / height);
            const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
            canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
            return await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .82));
        } finally {
            video.removeAttribute('src'); try { video.load(); } catch (_) {} URL.revokeObjectURL(source);
        }
    }
    async function uploadFiles(files, folderPath, read, metadata, update, userSignal,context) {
        if (!files.length || files.length > 100) throw new Error('DISK_BATCH_LIMIT');
        let signal = userSignal, serverFailure = null;
        const uploadRequest = async (url, options) => {
            if (serverFailure) throw serverFailure;
            try { return await raw(url, {...options,...context}); }
            catch (error) {
                if (serverFailure) throw serverFailure;
                if (!signal.aborted && error.transportFailure) {
                    const network = new Error('UPLOAD_CLIENT_NETWORK_ERROR');
                    const index = /\/files\/(\d+)$/.exec(url)?.[1], action = /\/(phase|queue|finish)$/.exec(url)?.[1];
                    network.errorDetails = { stage: 'browser-upload' + (index ? '/file-' + index : action ? '/' + action : ''), method: options?.method || 'GET', reason: String(error.message || '').slice(0, 200) };
                    throw network;
                }
                throw error;
            }
        };
        const plannedPartSize = 20_000_000;
        const plannedFiles = files.map(file => ({
            name: file.name, type: inferredType(file), size: file.size, ...(file.diskFolderPath!==undefined?{folderPath:file.diskFolderPath}:{}),
            parts: Array.from({ length: Math.max(1, Math.ceil(file.size / plannedPartSize)) }, (_, index) => {
                const byteStart = index * plannedPartSize, size = Math.min(plannedPartSize, file.size - byteStart);
                return { index: index + 1, byteStart, byteEnd: byteStart + size - 1, size };
            }),
            mediaIndex: String(file.type || '').startsWith('video/') ? { mode: 'unavailable', reason: 'container-parser-unavailable' } : undefined
        }));
        const blobs=[];
        const hashBlob=(blob,name)=>new Promise((resolve,reject)=>{
            const worker=new Worker('/client/disk-content-hash-worker.js');
            const finish=(error,value)=>{worker.terminate();userSignal.removeEventListener('abort',cancel);error?reject(error):resolve(value);};
            const cancel=()=>finish(abortError()); userSignal.addEventListener('abort',cancel,{once:true});
            worker.onerror=()=>finish(new Error('CONTENT_HASH_WORKER_FAILED'));
            worker.onmessage=event=>{if(event.data.error)finish(new Error(event.data.error));else if(event.data.sha256)finish(null,event.data.sha256);else update({phase:'content-hashing',message:'正在计算文件内容指纹：'+name,hashedBytes:event.data.bytes,hashTotalBytes:blob.size,percent:blob.size?event.data.bytes/blob.size*100:null});};
            if(userSignal.aborted)return cancel();worker.postMessage({file:blob});
        });
        for(let index=0;index<files.length;index++) {
            const blob=await read(files[index]);if(userSignal.aborted)throw abortError();blobs.push(blob);
            // Old browsers without Worker keep the established upload path;
            // the server still computes a trusted digest before publishing.
            if(typeof Worker==='function') {
                update({phase:'content-hashing',message:'正在计算文件内容指纹：'+files[index].name,hashedBytes:0,hashTotalBytes:blob.size,percent:null});
                try { plannedFiles[index].contentSha256=await hashBlob(blob,files[index].name); }
                catch(error) {
                    if(userSignal.aborted || error.name==='AbortError' || error.message==='OPERATION_CANCELLED')throw error;
                    console.warn('[telegram-drive] 内容摘要 Worker 不可用，改用普通上传',error.message);
                }
            }
        }
        const seenContent=new Set();
        const contentTickets=[];
        let job;
        try {
        for(let index=0;index<files.length;index++) {
            const blob=blobs[index],file=plannedFiles[index];
            if(!file.contentSha256)continue;
            const key=file.size+':'+file.contentSha256;
            if(seenContent.has(key))continue;seenContent.add(key);
            let preflight;
            do {
                update({phase:'content-preflight',message:'正在验证可复用内容：'+file.name,percent:null});
                preflight=(await uploadRequest('/content/preflight',withSignal(json('POST',{folderPath,files:[file]}),signal))).files[0];
                if(preflight.status==='wait')await delay(Math.max(4000,preflight.retryAfterMs || 4000),signal);
            }while(preflight.status==='wait');
            if(preflight.ticket)contentTickets.push(preflight.ticket);
            if(preflight.status==='proof' && (typeof crypto==='undefined' || typeof crypto.subtle?.digest!=='function')) {
                // LAN/non-secure browser contexts can lack WebCrypto even with
                // Worker support. No digest means no reuse authorization.
                await uploadRequest('/content/release',json('POST',{tickets:[preflight.ticket]})).catch(()=>{});
                preflight={status:'miss'};
            }
            if(preflight.status==='proof') {
                const proofMessage=completed=>`正在验证文件持有证明：${file.name} · ${completed}/${preflight.ranges.length}`;
                update({phase:'content-proof',message:proofMessage(0),percent:null});
                const digests=[];
                for(const range of preflight.ranges){const domain=new TextEncoder().encode('Drop2Tunnel-PoP-v1\0'),prefix=new Uint8Array(domain.length+32+12);prefix.set(domain);prefix.set(Uint8Array.from(preflight.nonce.match(/../g),byte=>parseInt(byte,16)),domain.length);const layout=new DataView(prefix.buffer,domain.length+32);layout.setUint32(0,Math.floor(range.offset/4294967296));layout.setUint32(4,range.offset>>>0);layout.setUint32(8,range.size);const bytes=new Uint8Array(await blob.slice(range.offset,range.offset+range.size).arrayBuffer()),sample=new Uint8Array(prefix.length+bytes.length);sample.set(prefix);sample.set(bytes,prefix.length);digests.push(Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',sample)),byte=>byte.toString(16).padStart(2,'0')).join(''));update({phase:'content-proof',message:proofMessage(digests.length),percent:null});}
                preflight=await uploadRequest('/content/proof',withSignal(json('POST',{ticket:preflight.ticket,digests}),signal));
            }
            if(preflight.reuseTicket){file.reuseTicket=preflight.reuseTicket;contentTickets.push(preflight.reuseTicket);}
            if(preflight.uploadTicket){file.uploadTicket=preflight.uploadTicket;contentTickets.push(preflight.uploadTicket);}
        }
        job = await uploadRequest('/uploads', withSignal(json('POST', { folderPath, metadata:Object.fromEntries(Object.entries(metadata).filter(([key])=>key!=='transportContext')), files: plannedFiles, progressive: true }), signal));
        } catch(error) {
            if(contentTickets.length)await uploadRequest('/content/release',json('POST',{tickets:[...new Set(contentTickets)]})).catch(()=>{});
            throw error;
        }
        const transfer = newAbortController(); signal = transfer.signal;
        const cancelTransfer = () => transfer.abort();
        userSignal.addEventListener?.('abort', cancelTransfer, { once: true });
        if (userSignal.aborted) cancelTransfer();
        const checkTerminal = snapshot => {
            const operation = snapshot.find(item => item.operation_id === job.operation_id);
            if (!operation || !['failed', 'cancelled'].includes(operation.status)) return;
            serverFailure ||= Object.assign(new Error(operation.status === 'cancelled' ? 'OPERATION_CANCELLED' : operation.errorCode || 'DISK_OPERATION_FAILED'), {
                errorDetails: operation.errorDetails, userMessage: operation.errorMessage, partialItems: operation.result?.partialItems
            });
            // This abort stops in-flight PUT/queue requests. It is not a user
            // cancellation and must never call the upload DELETE endpoint.
            transfer.abort();
        };
        terminalListeners.add(checkTerminal);
        operationContexts.set(job.operation_id,context);
        const closeProgress = subscribeUploadProgress(job,context);
        const sourceHeartbeat = setInterval(() => {
            if (!signal.aborted) uploadRequest('/uploads/' + job.uploadId + '/heartbeat', withSignal(json('POST', {}), signal)).catch(() => {});
        }, 30000);
        const totalBytes = plannedFiles.reduce((sum, file,index) => sum + (job.files?.[index]?.reused ? 0 : Number(file.size)), 0);
        let completedBytes = 0, lastProgressBytes = 0, lastProgressAt = Date.now(), lastPublishedAt = 0, uploadSpeed = 0;
        const reportClientProgress = (index, part, loaded, force = false) => {
            const count = plannedFiles[index].parts.length;
            const received = Math.min(totalBytes, Math.max(lastProgressBytes, completedBytes + part.byteStart + Math.min(part.size, loaded)));
            const now = Date.now(), elapsed = now - lastProgressAt;
            if (!force && now - lastPublishedAt < 250) return;
            if (elapsed > 0) {
                const currentSpeed = Math.max(0, received - lastProgressBytes) * 1000 / elapsed;
                uploadSpeed = uploadSpeed ? uploadSpeed * .65 + currentSpeed * .35 : currentSpeed;
            }
            lastProgressBytes = received; lastProgressAt = now; lastPublishedAt = now;
            update({ clientBytesReceived: received, clientTotalBytes: totalBytes, clientBytesPerSecond: uploadSpeed,
                clientFileIndex: index + 1, clientFileCount: files.length, clientFileName: files[index].name, clientFileSize: files[index].size,
                clientPartIndex: part.index, clientPartCount: count,
                message: `正在上传第 ${index + 1} 个文件的第 ${part.index}/${count} 个分片：${files[index].name}` });
        };
        let queue = job.queue;
        const waitForQueue = async () => {
            if (!job.uploadQueueCheck) return;
            while (!queue || queue.pendingParts >= 5 || queue.pendingBytes >= 100_000_000) {
                const status = await uploadRequest('/uploads/' + job.uploadId + '/queue', { signal });
                queue = status.queue;
                if (status.ready) return;
                update({ message: '服务器上传队列已满，等待 Telegram 消费后继续', queueParts: queue?.pendingParts, queueBytes: queue?.pendingBytes });
                await delay(Math.max(250, Number(status.retryAfterMs) || 1000), signal);
                await refresh();
            }
        };
        try {
            update({ operationId: job.operation_id });
            start();
            for (let index = 0; index < files.length; index++) {
                if(job.files?.[index]?.reused){update({phase:'content-reused',message:'已复用现有内容：'+files[index].name});continue;}
                await uploadRequest('/uploads/' + job.uploadId + '/phase', withSignal(json('POST', { index }), signal));
                await refresh();
                const blob = blobs[index];
                if (signal.aborted) throw abortError();
                const url = '/uploads/' + job.uploadId + '/files/' + index;
                // Extract the embedded audio cover / representative video frame
                // locally while regular chunks
                // continue entering the server queue. A codec the browser cannot
                // decode only skips the optional cover; it never fails the file.
                const thumbnailUpload = createUploadThumbnail(blob, plannedFiles[index]).then(thumbnail => {
                    if (!thumbnail?.size || signal.aborted) return;
                    return raw(url + '/thumbnail', { ...context, method: 'PUT', headers: { 'Content-Type': thumbnail.type || 'image/jpeg', 'X-Disk-Thumbnail-Size': String(thumbnail.size) }, body: thumbnail, signal });
                }).catch(error => { if (!signal.aborted && error?.name !== 'AbortError') console.warn('[telegram-drive] 媒体封面提取失败', error.message); });
                if (!blob.size) { await waitForQueue(); queue = (await uploadRequest(url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: blob, signal, onUploadProgress: loaded => reportClientProgress(index, plannedFiles[index].parts[0], loaded, true) })).queue; }
                for (const part of plannedFiles[index].parts) {
                    if (!blob.size) break;
                    const offset = part.byteStart, end = part.byteEnd + 1;
                    while (true) {
                        try {
                            await waitForQueue(); reportClientProgress(index, part, 0, true);
                            queue = (await uploadRequest(url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${offset}-${end - 1}/${blob.size}` }, body: blob.slice(offset, end), signal, onUploadProgress: loaded => reportClientProgress(index, part, loaded, loaded >= part.size) })).queue;
                            break;
                        }
                        catch (error) {
                            if (error.message !== 'UPLOAD_BACKPRESSURE') throw error;
                            queue = error.queue;
                            update({ message: '服务器上传队列已满，等待 Telegram 消费后继续', queueParts: error.queue?.pendingParts, queueBytes: error.queue?.pendingBytes });
                            await delay(Math.max(250, Number(error.retryAfterMs) || 500), signal);
                            await refresh();
                        }
                    }
                }
                completedBytes += blob.size;
                await thumbnailUpload;
            }
            const result = await performRequest('/uploads/' + job.uploadId + '/finish', { method: 'POST', signal,...context }, update);
            // Keep repair copies, even when the uploaded object originated outside this UI.
            for (let index = 0; index < result.items.length; index++) {
                await window.TelegramDriveCache?.put(result.items[index].id, { blob: blobs[index], name: files[index].name, type: files[index].type,cacheIdentity:result.items[index].cacheIdentity,logicalContentVersion:result.items[index].logicalContentVersion || 1 }).catch(() => {});
            }
            return result;
        } catch (error) {
            // A pipeline failure may remove its upload reservation while the next
            // browser request is in flight. Show the durable task's original cause.
            error = serverFailure || error;
            const cancelled = userSignal.aborted || error.message === 'OPERATION_CANCELLED';
            if (!cancelled) {
                if (error.transportFailure) {
                    const network = new Error('UPLOAD_CLIENT_NETWORK_ERROR');
                    network.errorDetails = { stage: 'browser-upload/finish', method: 'POST', reason: String(error.message || '').slice(0, 200) };
                    error = network;
                }
                const failed = await raw('/operations/' + encodeURIComponent(job.operation_id),context).catch(() => null);
                if (failed?.errorCode) {
                    const original = new Error(failed.errorCode);
                    original.errorDetails = failed.errorDetails; original.userMessage = failed.errorMessage;
                    original.partialItems = failed.result?.partialItems;
                    error = original;
                }
            }
            for (let index = 0; index < (error.partialItems?.length || 0); index++) {
                await window.TelegramDriveCache?.put(error.partialItems[index].id, { blob: blobs[index], name: files[index].name, type: files[index].type,logicalContentVersion:error.partialItems[index].logicalContentVersion || 1 }).catch(() => {});
            }
            if (cancelled) await raw('/uploads/' + job.uploadId, { method: 'DELETE',...context }).catch(() => {});
            else await raw('/uploads/' + job.uploadId + '/failure', {...context,...json('POST', {
                errorCode: error.message, reason: error.errorDetails?.reason || error.message,
                stage: error.errorDetails?.stage, method: error.errorDetails?.method
            })}).catch(() => {});
            throw error;
        } finally { if (sourceHeartbeat !== undefined) clearInterval(sourceHeartbeat); closeProgress(); terminalListeners.delete(checkTerminal); userSignal.removeEventListener?.('abort', cancelTransfer); refresh(); }
    }
    async function read(item, options = {}) {
        const context={...transportContext(),...item.diskTransportContext,...options};
        const controller = newAbortController();
        readContexts.set(controller, context);
        const signal = options.signal && typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function' ? AbortSignal.any([options.signal, controller.signal]) : (options.signal || controller.signal);
        let operationId = '';
        if (!pendingReads.has(item.id)) pendingReads.set(item.id, new Set());
        pendingReads.get(item.id).add(controller); cacheChanged();
        const run = update => readFile(item, { ...context, signal }, values => {
            if (values.operationId && values.operationId !== operationId) { if (operationId) readControllers.delete(operationId); operationId = values.operationId;operationContexts.set(operationId,context); readControllers.set(operationId, controller); }
            if (options.silentLoading && values.operationId) hiddenLoadingOperations.add(values.operationId);
            update(values);
        });
        try { return options.silentLoading ? await run(() => {}) : await withActivity({ message: '正在打开文件：' + item.name, folderPath: item.folderPath || '', accountId: context.accountId || '' }, run); }
        finally { readContexts.delete(controller); if (operationId) readControllers.delete(operationId); const readers = pendingReads.get(item.id); readers?.delete(controller); if (!readers?.size) pendingReads.delete(item.id); if (![...(readers || [])].some(reader => readContexts.get(reader)?.accountId === context.accountId)) setCacheProgress(item.id, null, context); cacheChanged(); }
    }
    async function readFile(item, { signal,requestBase=baseUrl(),diskSpace:requestSpace=diskSpace,accountId:requestAccount=accountId }, update) {
        const progress = value => setCacheProgress(item.id, value, { accountId: requestAccount });
        if(requestBase.includes('/mount-scope/'))item={...item,...await raw('/files/'+encodeURIComponent(item.id),{signal,requestBase,diskSpace:requestSpace,accountId:requestAccount})};
        const cached = await window.TelegramDriveCache?.get(item.id,item).catch(() => null);
        if (cached?.blob && cached.blob.size === item.size) return cached.blob;
        start();
        // The server streams Telegram parts as they arrive. Only bytes received
        // by this browser count toward the file badge's 0-100% progress.
        progress({ phase: 'telegram', percent: 0 });
        const response = await fetch(withSpace(requestBase + '/files/' + encodeURIComponent(item.id) + '/download',requestSpace), { credentials: 'same-origin', cache: 'no-store', headers: { ...accountHeaders(requestAccount), 'X-Disk-Device-Id': deviceId }, signal });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'DISK_READ_FAILED');
        update({ operationId: response.headers?.get('X-Disk-Operation-Id') || '', message: '正在接收文件：' + item.name });
        const total = Math.max(0, Number(response.headers?.get('Content-Length')) || Number(item.size) || 0);
        let blob;
        if (response.body?.getReader) {
            const reader = response.body.getReader(), chunks = []; let received = 0;
            progress({ phase: 'browser', percent: 0, receivedBytes: 0, totalBytes: total });
            while (true) {
                const { done, value } = await reader.read(); if (done) break;
                chunks.push(value); received += value.byteLength;
                const percent = total ? Math.min(100, received / total * 100) : null;
                progress({ phase: 'browser', percent, receivedBytes: received, totalBytes: total });
            }
            blob = new Blob(chunks, { type: item.type || response.headers?.get('Content-Type') || 'application/octet-stream' });
        } else blob = await response.blob();
        if (Number(item.size) > 0 && blob.size !== Number(item.size)) throw new Error('DISK_READ_SIZE_MISMATCH');
        await window.TelegramDriveCache?.put(item.id, { blob, name: item.name, type: item.type,cacheIdentity:item.cacheIdentity,logicalContentVersion:item.logicalContentVersion || 1 }).catch(() => {});
        progress({ phase: 'done', percent: 100 });
        refresh(); return blob;
    }
    function streamUrl(item, { purpose = '', fresh = false } = {}) {
        const context = item.diskTransportContext || transportContext();
        const query = new URLSearchParams();
        query.set('v', String(item.updatedAt || item.size || 0));
        if (context.diskSpace) query.set('disk_space', context.diskSpace);
        if (context.accountId) query.set('disk_account', context.accountId);
        if (purpose) query.set('purpose', String(purpose));
        if (fresh) query.set('request', String(++streamSequence));
        return context.requestBase + '/files/' + encodeURIComponent(item.id) + '/stream?' + query;
    }
    async function readRange(item, start = 0, end = Number(item.size) - 1, { signal, purpose = 'metadata' } = {}) {
        const safeStart = Math.max(0, Number(start) || 0);
        const safeEnd = Math.min(Number(item.size) - 1, Math.max(safeStart, Number(end) || 0));
        const response = await fetch(streamUrl(item, { purpose, fresh: true }), {
            credentials: 'same-origin', cache: 'no-store', signal,
            headers: { Range: `bytes=${safeStart}-${safeEnd}`, ...accountHeaders((item.diskTransportContext || transportContext()).accountId), 'X-Disk-Device-Id': deviceId }
        });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'DISK_READ_FAILED');
        let blob = await response.blob();
        const expected = safeEnd - safeStart + 1;
        if (response.status === 200 && blob.size === Number(item.size)) blob = blob.slice(safeStart, safeEnd + 1, item.type || blob.type);
        if (blob.size !== expected) throw new Error('DISK_READ_SIZE_MISMATCH');
        return blob;
    }
    async function cancelOperation(id) {
        uploadControllers.get(id)?.abort();
        readControllers.get(id)?.abort();
        if (!String(id).startsWith('local-upload-')) await raw('/operations/' + encodeURIComponent(id), { method: 'DELETE',...(operationContexts.get(id)||{}) });
        refresh(true); return true;
    }
    function cancelRead(id) {
        const readers = pendingReads.get(id); if (!readers?.size) return false;
        for (const controller of readers) if ((readContexts.get(controller)?.accountId || '') === accountId) controller.abort();
        return true;
    }
    function changeTaskView(change) {
        const previous=contextKey(transportContext());change();
        if(previous!==contextKey(transportContext())){viewOperationIds.clear();emit();}
        start();if(polling)polling.finally(()=>refresh(true));else refresh(true);
    }
    async function accountOperations(selectedAccount = accountId) {
        // Read this account's task history, including other pages. A readable
        // collaboration lists its owner's tasks; opening every grant here
        // would both misattribute those tasks and depend on source availability.
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), 20000) : null;
        const read = async (url, context) => { const value = await raw(url, { ...context, ...(controller ? { signal:controller.signal } : {}) }); if (controller?.signal.aborted) throw abortError(); return value; };
        try {
            const identity = selectedAccount || (await read('/me', {accountId:'',diskSpace:'',requestBase:base})).identity?.id || '';
            if (!identity) return {accountId:'',operations:[]};
            const peers=peerAccountOperations(identity);
            const context = {accountId:identity,diskSpace:'',requestBase:base};
            const partitions = await read('/spaces', context);
            const contexts = new Map(), add = scope => contexts.set(contextKey(scope),scope);
            for (const space of partitions.spaces || []) add({...context,diskSpace:String(space.scopeKey ?? space.diskSpace ?? '')});
            if (!contexts.size) add(context);
            const found = new Map(localAccountOperations(identity).map(job=>[job.operation_id,job]));
            const queue=[...contexts.values()];
            const inspect = async () => { while(queue.length) { const scope=queue.shift(), data=await read('/operations',scope); for(const job of data.operations || []) found.set(job.operation_id,job); } };
            await Promise.all(Array.from({length:Math.min(4,queue.length)},inspect));
            for(const job of await peers)if(!found.has(job.operation_id))found.set(job.operation_id,job);
            const operations=sortJobs([...found.values()].filter(active).filter(job=>!(job.type==='transfer-history'&&[...found.values()].some(other=>other.historyMirrorId===job.operation_id&&active(other)))));
            return {accountId:identity,operations};
        } catch(error) {
            const timedOut=controller?.signal.aborted; controller?.abort();
            if(timedOut) { const message='当前账号活动任务检查超时，请重试后再切换账号'; throw new Error(window.TunnelI18n?.t(message)||message); }
            if(selectedAccount && (error.status===401 || error.message==='LOGIN_REQUIRED')) {
                const operations=sortJobs(localAccountOperations(selectedAccount));
                return {accountId:selectedAccount,operations,unverified:true};
            }
            throw error;
        }
        finally { if(timer!==null)clearTimeout(timer); }
    }
    window.DiskClient = { context:transportContext,raw, request, json, upload, read, readRange, wait, start, stop, stopAccount, refresh, withActivity, cancelOperation, cancelRead, streamUrl, accountOperations,
        setAccount(value) { const selected=String(value||''); if(selected===accountId)return; changeTaskView(()=>{accountId=selected;mountId='';collaborationId='';diskSpace='';}); emitActivities(); },
        getAccount() { return accountId; },
        setSpace(value) { changeTaskView(()=>{mountId='';collaborationId='';diskSpace=String(value||'');}); },
        getSpace() { return diskSpace; },
        hasActiveOperations() { return visibleJobs().some(active); },
        setMount(id) { changeTaskView(()=>{mountId=String(id||'');collaborationId='';}); },
        getMount(){return mountId;},
        setCollaboration(id) { changeTaskView(()=>{mountId='';collaborationId=String(id||'');}); },
        setAudioCoverExtractor(extractor) { audioCoverExtractor = typeof extractor === 'function' ? extractor : null; },
        isCaching(id) { return [...(pendingReads.get(id) || [])].some(controller => (readContexts.get(controller)?.accountId || '') === accountId); },
        cacheProgress(id) { return cacheProgressByFile.get(cacheKey(id)) || null; },
        isLoadingHidden(id) { return hiddenLoadingOperations.has(id); },
        hideLoading(id) { if (id) hiddenLoadingOperations.add(id); },
        showLoading(id) { if (id) hiddenLoadingOperations.delete(id); },
        hasHiddenLoading() { return [...hiddenLoadingOperations].some(id => contextKey(operationContexts.get(id) || transportContext()) === contextKey(transportContext())); },
        subscribeActivity(listener) { activityListeners.add(listener); listener([...activities].filter(activity => activity.accountId === accountId)); return () => activityListeners.delete(listener); },
        subscribe(listener) { listeners.add(listener); listener(visibleJobs()); return () => listeners.delete(listener); } };
})();
