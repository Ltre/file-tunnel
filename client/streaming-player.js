(function (global) {
    'use strict';
    const t = value => global.TunnelI18n?.t(value) || value;
    function renderRich(node, body, references, mapping) {
        if (!global.DOMPurify) throw Error('STREAM_RENDER_UNAVAILABLE');
        node.innerHTML = global.DOMPurify.sanitize(body, { FORBID_TAGS: ['script','style','iframe','object','embed','form','input','button','audio','video','source'], FORBID_ATTR: ['style','srcset'] });
        for (const image of node.querySelectorAll('img[data-tunnel-asset-id]')) {
            const ref = references.find(value => value.url.endsWith('/editor-assets/' + image.dataset.tunnelAssetId));
            const url = ref && mapping.get(ref.url);
            if (url) image.src = url; else image.removeAttribute('src');
        }
        for (const link of node.querySelectorAll('a')) { link.rel = 'noopener noreferrer'; link.target = '_blank'; }
    }
    // Only this device's cursor retains loading time. Explicit global commands
    // still replace it; station permissions and the server clock are unchanged.
    function create({ stationId, watchId, request, subscribe, onState, onItemChange, onPlaybackChange, onError, onRecovery, onSeek, mediaUrl = access => access.url }) {
        const initialWatchId = watchId; let resumeCount = 0;
        const host = document.createElement('section'); host.className = 'sc-player';
        host.innerHTML = '<div class="sc-stage"><div class="sc-media"></div><span class="sc-countdown"></span><span class="sc-muted" hidden></span></div><div class="sc-local-controls"></div><p class="sc-play-status" role="status"></p>';
        const stage = host.querySelector('.sc-stage'), content = host.querySelector('.sc-media'), countdown = host.querySelector('.sc-countdown');
        const controls = host.querySelector('.sc-local-controls'), statusNode = host.querySelector('.sc-play-status'), muteNode = host.querySelector('.sc-muted');
        const buffering = document.createElement('div'); buffering.className = 'sc-buffering'; buffering.hidden = true; buffering.setAttribute('role', 'status'); buffering.setAttribute('aria-live', 'polite'); buffering.textContent = t('正在缓冲'); stage.append(buffering);
        const seekBar = document.createElement('div'); seekBar.className = 'sc-seek'; seekBar.hidden = true;
        const seek = document.createElement('input'); seek.type = 'range'; seek.min = 0; seek.step = .1; seek.setAttribute('aria-label', t('调整全台播放进度'));
        const seekLabel = document.createElement('span'); seekLabel.className = 'sc-seek-label'; seekBar.append(seek, seekLabel); host.append(seekBar);
        let dragging = false;
        seek.oninput = () => { dragging = true; seekLabel.textContent = Number(seek.value).toFixed(1) + ' s'; };
        seek.onchange = async () => { const id = currentId, position = Number(seek.value); seek.disabled = true;
            try { if (snapshot?.manageable && onSeek) await onSeek(id, position); } catch (error) { onError?.(error); }
            finally { dragging = false; seek.disabled = false; update(); } };
        let snapshot, receivedAt = 0, currentId = '', media, active, next, generation = 0, paused = false, muted = false, volume = 1;
        let actual = 'waiting', failure = '', lastMediaError = '', alive = true, denied = false, localPosition = 0, lastTick = performance.now(), delay = 0, loadCost = 1, tail = false;
        let polling = false, reporting = false, reportGeneration = 0, pageSuspended = false, accessGeneration = 0, lastStateAt = 0, unsubscribe;
        let reportController, reportRetryTimer, reportRetries = 0, lastReportError = '';
        let foreground = true, background = global.localStorage?.getItem('streaming-background-playback') !== 'off';
        const backgroundPaused = () => !background && (!foreground || document.hidden);
        const locallyPaused = () => paused || backgroundPaused();
        const backgroundLabel = document.createElement('label'); backgroundLabel.className = 'sc-background-toggle';
        const backgroundToggle = document.createElement('input'); backgroundToggle.type = 'checkbox'; backgroundToggle.checked = background;
        backgroundLabel.textContent = t('后台播放'); backgroundLabel.append(backgroundToggle); host.append(backgroundLabel);
        function setBackground(enabled) { background = Boolean(enabled); backgroundToggle.checked = background; try { global.localStorage?.setItem('streaming-background-playback', background ? 'on' : 'off'); } catch (_) {} sync(); update(); }
        backgroundToggle.onchange = () => setBackground(backgroundToggle.checked);
        const visibilityChanged = () => { lastTick = performance.now(); sync(); update(); };
        document.addEventListener?.('visibilitychange', visibilityChanged);
        const button = (label, run) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = t(label); b.onclick = run; controls.append(b); return b; };
        const localPause = button('暂停本机观看', () => { const retry = actual === 'blocked' || actual === 'error'; paused = retry ? false : !paused; if (paused) { media?.pause(); actual = 'paused'; } else if (actual !== 'blocked') align(); lastTick = performance.now(); sync(true); update(); });
        function applyAudioPolicy() { for(const node of new Set([media,active?.media,next?.media]))if(node){node.muted=muted;node.defaultMuted=muted;node.volume=muted?0:volume;} }
        const sound = button('静音', () => { muted = !muted; applyAudioPolicy(); sync(true); update(); });
        localPause.className = 'sc-local-pause'; sound.className = 'sc-sound-toggle';
        localPause.dataset.icon = '❚❚'; sound.dataset.icon = '🔇';
        const volumeLabel = document.createElement('label'); volumeLabel.textContent = t('本机音量');
        const slider = document.createElement('input'); slider.type = 'range'; slider.min = 0; slider.max = 1; slider.step = .01; slider.value = 1; slider.setAttribute('aria-label', t('本机音量'));
        slider.oninput = () => { volume = Number(slider.value); applyAudioPolicy(); update(); }; volumeLabel.append(slider); controls.append(volumeLabel);
        // Resume is also the user gesture for browsers that block audible autoplay.
        let fullscreen = false, landscape = false;
        function resizeFullscreen() {
            if (!fullscreen) return;
            const viewport = global.visualViewport;
            const width = viewport?.width || global.innerWidth, height = viewport?.height || global.innerHeight;
            const rotated = landscape !== (width >= height);
            host.style.setProperty('--sc-fullscreen-width', (rotated ? height : width) + 'px');
            host.style.setProperty('--sc-fullscreen-height', (rotated ? width : height) + 'px');
            host.classList.toggle('sc-fullscreen-rotated', rotated);
            rotateFullscreen.title = t(landscape ? '切换竖屏' : '切换横屏');
            rotateFullscreen.setAttribute('aria-label', rotateFullscreen.title);
            rotateFullscreen.setAttribute('aria-pressed', String(landscape));
        }
        function exitFullscreen() {
            fullscreen = false;
            host.classList.remove('sc-media-fullscreen'); host.classList.remove('sc-fullscreen-rotated');
            global.removeEventListener('resize', resizeFullscreen);
            global.visualViewport?.removeEventListener('resize', resizeFullscreen);
        }
        const enterFullscreen = button('媒体全屏', () => {
            if (fullscreen) { exitFullscreen(); return; }
            fullscreen = true;
            landscape = (global.visualViewport?.width || global.innerWidth) >= (global.visualViewport?.height || global.innerHeight);
            host.classList.toggle('sc-media-fullscreen', true);
            global.addEventListener('resize', resizeFullscreen);
            global.visualViewport?.addEventListener('resize', resizeFullscreen);
            resizeFullscreen();
        }); enterFullscreen.className = 'sc-window-only';
        const rotateFullscreen = button('切换横屏', () => { landscape = !landscape; resizeFullscreen(); }); rotateFullscreen.className = 'sc-rotate-fullscreen'; rotateFullscreen.textContent = '↻';
        const leaveFullscreen = button('退出全屏', exitFullscreen); leaveFullscreen.className = 'sc-exit-fullscreen';
        leaveFullscreen.textContent = ''; const exitIcon = document.createElement('img'); exitIcon.src = '/client/icons/quit-fullscreen.png'; exitIcon.alt = ''; exitIcon.setAttribute('aria-hidden', 'true'); leaveFullscreen.append(exitIcon); leaveFullscreen.title = t('退出全屏'); leaveFullscreen.setAttribute('aria-label', t('退出全屏'));
        const length = item => item?.duration ? item.duration - (item.start || 0) : item?.stay || 0;
        const itemKey = item => JSON.stringify([snapshot?.configVersion, item?.id, item?.kind, item?.duration, item?.start, item?.stay]);
        const current = () => snapshot?.items.find(item => item.id === currentId);
        const running = () => snapshot?.playback.status === 'playing' || tail;
        const isPlaying = () => Boolean(alive && !denied && !pageSuspended && !locallyPaused() && running() && ['playing', 'reading', 'buffering'].includes(actual));
        let lastPlaying;
        function notifyPlayback() { const value = isPlaying(); if (value !== lastPlaying) { lastPlaying = value; onPlaybackChange?.(value); } }
        function globalPosition() { const item = snapshot?.items.find(item => item.id === snapshot.playback.itemId); return Math.min(length(item), (snapshot?.playback.position || 0) + (snapshot?.playback.status === 'playing' ? Math.max(0, performance.now() - receivedAt) / 1000 : 0)); }
        function update() {
            const adminPaused = snapshot?.playback.status === 'paused';
            const pauseLabel = adminPaused ? '已被管理员暂停' : backgroundPaused() ? '后台播放已关闭' : paused ? '本机已暂停' : '';
            buffering.hidden = !pauseLabel && actual !== 'buffering';
            buffering.textContent = t(pauseLabel || '正在缓冲');
            buffering.classList.toggle('sc-paused', Boolean(pauseLabel));
            const selected = current(); seekBar.hidden = !snapshot?.manageable || !selected || !onSeek;
            if (selected && !dragging) { seek.max = length(selected); seek.value = Math.min(localPosition, length(selected)); seekLabel.textContent = localPosition.toFixed(1) + ' / ' + length(selected).toFixed(1) + ' s'; }
            const statuses = { playing: '正在播放', paused: '本机已暂停', buffering: '缓冲中', waiting: '等待播放', blocked: '浏览器限制播放，请点击恢复播放', error: '播放失败，请重试', reading: '正在展示' };
            const silent = muted || volume === 0;
            // Replacing unchanged button children during a mouse press can
            // cancel Chromium's click on the full-screen icon/pseudo-element.
            const soundLabel = t(muted ? '取消静音' : '静音');
            if (sound.textContent !== soundLabel) sound.textContent = soundLabel;
            muteNode.hidden = !silent; muteNode.textContent = t('已静音');
            localPause.dataset.icon = paused || actual === 'blocked' || actual === 'error' ? '▶' : '❚❚'; sound.dataset.icon = muted ? '🔊' : '🔇';
            const pauseText = t(actual === 'blocked' || actual === 'error' ? '恢复播放' : paused ? '恢复跟随' : '暂停本机观看');
            if (localPause.textContent !== pauseText) localPause.textContent = pauseText;
            for (const control of [localPause, sound]) { control.title = control.textContent; control.setAttribute('aria-label', control.textContent); }
            statusNode.textContent = (pauseLabel ? t(pauseLabel) : failure || t(!paused && actual === 'paused' ? '等待全台播放' : statuses[actual] || '等待播放')) + (silent ? ' · ' + t('已静音') : '') + (delay >= 1 ? ' · ' + t('本机加载延迟（秒）') + ' ' + delay.toFixed(1) : '');
            statusNode.dataset.status = actual;
            const item = current();
            const remaining = Math.max(0, length(item) - localPosition);
            if (item && remaining <= 99 && remaining > 0 && !locallyPaused() && running() && active?.ready) {
                countdown.hidden = false; countdown.textContent = String(Math.ceil(remaining)); countdown.dataset.position = snapshot.countdown || 'bottom-right';
                stage.style.setProperty('--sc-remaining', String(remaining / Math.min(99,length(item)))); stage.classList.toggle('sc-edge-countdown', snapshot.countdown === 'edge');
            } else { countdown.hidden = true; stage.classList.remove('sc-edge-countdown'); }
            notifyPlayback();
        }
        function dispose(task) {
            if (!task || task.disposed) return; task.disposed = true; clearTimeout(task.loadTimer); task.controller.abort();
            task.media?.pause(); task.element?.querySelectorAll?.('img,audio,video,source').forEach(node => { node.pause?.(); node.removeAttribute('src'); node.load?.(); });
            task.media?.removeAttribute('src'); task.media?.load(); if (task.element?.tagName === 'IMG') task.element.removeAttribute('src');
            if (task.clientUrl) URL.revokeObjectURL(task.clientUrl); task.clientChunks = null;
            if(task.url?.startsWith('blob:'))URL.revokeObjectURL(task.url);
        }
        function clearNext() { dispose(next); next = null; }
        function accessError(error) {
            if (!['STREAM_KICKED', 'STREAM_INVITATION_REQUIRED', 'STREAM_OFFLINE', 'STREAM_NOT_FOUND', 'STREAM_DEVICE_DENIED'].includes(error.message)) return false;
            denied = true; accessGeneration++; generation++; dispose(active); clearNext(); media = null; active = null; currentId = ''; content.replaceChildren(); tail = false; actual = 'waiting'; failure = t('访问已结束') + ' [' + error.message + ']'; unsubscribe?.();
            if (snapshot) onState?.({ ...snapshot, visibility: error.message === 'STREAM_OFFLINE' ? 'offline' : 'restricted', items: [], playback: { ...snapshot.playback, status: 'stopped' } });
            update(); return true;
        }
        async function report(resuming = false) {
            if (!alive || denied || (reporting || pageSuspended) && resuming !== true) return; reporting = true; const revision = accessGeneration, reportRevision = ++reportGeneration;
            clearTimeout(reportRetryTimer); reportController?.abort();
            const controller = reportController = new AbortController(), deadline = setTimeout(() => controller.abort(), 10000);
            try {
                const result = await request('/stations/' + stationId + '/report', 'POST', { watchId, itemId: currentId, position: media?.currentTime ?? localPosition, status: actual }, { signal: controller.signal });
                if (alive && revision === accessGeneration && reportRevision === reportGeneration && result.station) {
                    reportRetries = 0;
                    if (lastReportError) { const code = lastReportError; lastReportError = ''; onRecovery?.(code); }
                    if (resuming === true) { pageSuspended = false; lastTick = performance.now(); } apply(result.station);
                }
            }
            catch (cause) {
                if (alive && revision === accessGeneration && reportRevision === reportGeneration) {
                    const error = controller.signal.aborted ? Error('STREAM_CONTROL_TIMEOUT') : cause;
                    lastReportError = error.message;
                    accessError(error); onError?.(error);
                    // A failed first join must not wait for the next normal
                    // heartbeat. Steady-state reports remain every 15 seconds.
                    if (!denied && reportRetries < 3) reportRetryTimer = setTimeout(() => report(resuming), 2000 * 2 ** reportRetries++);
                }
            } finally { clearTimeout(deadline); if (reportRevision === reportGeneration) { reporting = false; reportController = null; } }
        }
        function unwatch() { accessGeneration++; request('/stations/' + stationId + '/unwatch', 'POST', { watchId }, { keepalive: true }).catch(() => {}); }
        const hidePage = () => { pageSuspended = true; media?.pause(); unwatch(); clearTimeout(reportRetryTimer); reportController?.abort(); };
        const resumePage = event => { if (event.persisted) { watchId = initialWatchId + ':' + (++resumeCount); denied = false; report(true); } };
        global.addEventListener('pagehide', hidePage); global.addEventListener('pageshow', resumePage);
        async function mediaFailure(task, node) {
            const code = Number(node.error?.code) || 0;
            if (code === 3) return Error('STREAM_MEDIA_DECODE_FAILED');
            let cause = Error(code === 2 ? 'STREAM_MEDIA_NETWORK_FAILED' : 'STREAM_MEDIA_UNAVAILABLE');
            // Native media elements hide HTTP error bodies. Only on failure,
            // inspect a single byte through the same authorized ticket; never
            // download the whole file or expose the source account to viewers.
            const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), 5000);
            const cancel = () => timeout.abort();
            task.controller.signal.addEventListener('abort', cancel, { once: true });
            if (task.controller.signal.aborted) cancel();
            try {
                const response = await fetch(task.url, { headers: { Range: 'bytes=0-0' }, cache: 'no-store', signal: timeout.signal });
                if (!response.ok && (response.headers?.get('Content-Type') || '').includes('application/json')) {
                    const result = await response.json();
                    if (/^(STREAM_[A-Z_]+|LOGIN_REQUIRED)$/.test(result.error || '')) cause = Error(result.error);
                } else await response.body?.cancel();
            } catch (_) { /* Keep the original media error when diagnosis is unavailable. */ }
            finally { clearTimeout(timer); task.controller.signal.removeEventListener('abort', cancel); }
            return cause;
        }
        function failMedia(task, error) {
            if (active !== task || task.disposed || !alive || accessError(error)) return;
            actual = 'error';
            task.retryAt = ['STREAM_MEDIA_DECODE_FAILED', 'STREAM_TYPE_UNSUPPORTED', 'STREAM_SOURCE_DELETED', 'STREAM_SOURCE_REVOKED'].includes(error.message) ? 0 : performance.now() + 2000 * 2 ** task.retries;
            const message = error.message === 'STREAM_MEDIA_DECODE_FAILED' ? '浏览器无法解码该媒体，请检查格式与编码' : error.message === 'STREAM_MEDIA_STALLED' ? '播放持续没有进展，已重试，请点击恢复播放' : '资源读取失败，请检查台状态与来源';
            lastMediaError = error.message; failure = t(message) + ' [' + error.message + ']'; update(); onError?.(error);
        }
        function recovered() {
            if (!lastMediaError) return;
            const code = lastMediaError; lastMediaError = ''; onRecovery?.(code);
        }
        function prepare(item) {
            const task = { item, key: itemKey(item), controller: new AbortController(), ready: false, disposed: false, started: performance.now() };
            const signal = task.controller.signal;
            const deadline = task.loadTimer = setTimeout(() => { task.timedOut = true; task.controller.abort(); }, 30000);
            const ticket = reference => request('/stations/' + stationId + '/ticket', 'POST', { itemId: item.id, reference }, { signal });
            task.promise = (async () => {
                const access = await ticket(); if (task.disposed) return; task.expiresAt = access.expiresAt; task.url = await mediaUrl(access,signal,item); if(task.disposed){if(task.url.startsWith('blob:'))URL.revokeObjectURL(task.url);return;} if(signal.aborted)throw Error('STREAM_MEDIA_TIMEOUT');task.size = Number(access.size) || 0; task.warmCursor = 0; task.type = access.type;
                if (task.size > 0 && task.size <= 16 * 1024 * 1024) task.clientChunks = [];
                if (['audio', 'video', 'image'].includes(item.kind)) {
                    const node = document.createElement(item.kind === 'image' ? 'img' : item.kind); task.element = node;
                    if (item.kind !== 'image') { task.media = node; node.playsInline = true; node.preload = 'auto'; node.muted = muted; node.volume = volume; }
                    else { node.alt = item.name; node.decoding = 'async'; }
                    await new Promise((resolve, reject) => {
                        node.addEventListener(item.kind === 'image' ? 'load' : 'canplay', () => { if (!task.disposed) resolve(); }, { once: true });
                        node.addEventListener('error', () => { if (!task.disposed && !task.ready) mediaFailure(task, node).then(reject); }, { once: true });
                        signal.addEventListener('abort', () => reject(Object.assign(Error('Aborted'), { name: 'AbortError' })), { once: true });
                        node.src = task.url;
                    });
                } else {
                    const response = await fetch(task.url, { cache: 'no-store', signal }); if (!response.ok) throw Error('STREAM_SOURCE_UNAVAILABLE');
                    const body = await response.text(); if (task.disposed) return;
                    const node = document.createElement('div'); node.className = 'sc-document message-content'; task.element = node;
                    if (item.kind === 'markdown' || item.kind === 'rich') {
                        const mapping = new Map(), refs = [...(access.references || [])];
                        const resolve = async () => { while (refs.length && !task.disposed) { const ref = refs.shift(); try { const delegated = await ticket(ref.id); mapping.set(ref.url, delegated.url); } catch (error) { if (signal.aborted) throw error; } } };
                        await Promise.all([resolve(), resolve()]); if (task.disposed) return;
                        if(item.kind==='markdown')global.TunnelMarkdown.render(node, body, mapping);
                        else renderRich(node, body, access.references || [], mapping);
                    } else { const pre = document.createElement('pre'); pre.textContent = body; node.append(pre); }
                }
                if (!task.disposed) task.ready = true;
            })().catch(error => { throw task.timedOut ? Error('STREAM_MEDIA_TIMEOUT') : error; }).finally(() => clearTimeout(deadline));
            task.promise.catch(() => {}); return task;
        }
        async function load(item, position = 0, retries = 0) {
            const previousId = currentId;
            const revision = ++generation; dispose(active); media = null; active = null; currentId = item?.id || ''; localPosition = position; failure = ''; actual = item ? 'buffering' : 'waiting';
            content.replaceChildren(); countdown.hidden = true; const started = performance.now();
            if (currentId !== previousId) onItemChange?.(currentId);
            if (!item) { clearNext(); update(); return; }
            const task = next?.key === itemKey(item) && (!next.expiresAt || next.expiresAt > Date.now() + 10000) ? next : prepare(item);
            if (next !== task) clearNext(); else next = null; active = task; task.retries = retries; update();
            try {
                await task.promise; if (revision !== generation || !alive || denied || task.disposed) return;
                const wait = Math.max(0, performance.now() - started) / 1000;
                loadCost = Math.max(.25, Math.min(60, Math.max(loadCost * .7, (performance.now() - task.started) / 1000)));
                if (running() && !pageSuspended) delay += wait;
                media = task.media; content.replaceChildren(task.element); lastTick = performance.now(); task.progressAt = lastTick; task.lastPosition = position;
                if (media) {
                    applyAudioPolicy(); media.currentTime = Math.min((item.start || 0) + localPosition, Math.max(0, media.duration - .05));
                    media.addEventListener('playing', () => { if (active === task) { actual = 'playing'; failure = ''; recovered(); lastTick = performance.now(); update(); } });
                    media.addEventListener('waiting', () => { if (active === task) { actual = 'buffering'; recoverBuffered(task); update(); } });
                    media.addEventListener('error', () => { if (active === task && !task.diagnosing) {
                        if (recoverBuffered(task)) return;
                        task.diagnosing = true; actual = 'error'; update();
                        mediaFailure(task, media).then(error => failMedia(task, error)).finally(() => { task.diagnosing = false; });
                    } });
                    media.addEventListener('ended', () => { if (active === task) { localPosition = length(item); sync(); } });
                    if (item.kind === 'audio') { const title = document.createElement('p'); title.className = 'message-content sc-audio-title'; title.textContent = '♪ ' + item.name; content.append(title); }
                } else actual = paused || !running() ? 'paused' : 'reading';
                recovered(); sync(true); update();
            } catch (error) { if (revision !== generation || !alive || task.disposed) return; failMedia(task, error); }
        }
        function following() {
            const items = (snapshot?.items || []).filter(item => !item.unavailable), index = items.findIndex(item => item.id === currentId);
            return index < 0 || !items.length || index === items.length - 1 && !snapshot.loop ? null : items[(index + 1) % items.length];
        }
        function recoverBuffered(task) {
            if (active !== task || task.disposed || !task.clientUrl || task.usingClient) return false;
            task.usingClient = true; const element = task.media, position = element.currentTime; actual = 'buffering';
            element.addEventListener('loadedmetadata', () => { if (active === task && !task.disposed) element.currentTime = Math.min(position, Number.isFinite(element.duration) ? Math.max(0, element.duration - .05) : position); }, { once: true });
            element.addEventListener('canplay', () => { if (active === task && !task.disposed) sync(true); }, { once: true });
            element.src = task.clientUrl; element.load(); return true;
        }
        async function warmCurrent() {
            const task = active;
            if (!alive || denied || pageSuspended || locallyPaused() || !running() || !task?.ready || !media || media !== task.media || !task.size || task.clientUrl || task.url?.startsWith('blob:') || task.warming || performance.now() < (task.warmAt || 0)) return;
            const unit = 1024 * 1024, item = current();
            // Time-to-byte conversion is only a read-ahead hint; media decoding
            // and seeking stay with the browser's native Range implementation.
            const bufferedTime = media?.buffered?.length ? media.buffered.end(media.buffered.length - 1) : (item?.start || 0) + localPosition;
            if (Number.isFinite(media?.duration) && bufferedTime >= media.duration - .05) return;
            const approximate = Math.max(0, Math.floor(bufferedTime / Math.max(1, media.duration) * task.size / unit) * unit);
            if (!task.clientChunks) task.warmCursor = Math.max(task.warmCursor, approximate);
            const start = task.warmCursor, end = Math.min(task.size - 1, start + 4 * unit - 1);
            if (!task.clientChunks && start >= approximate + 16 * unit) return;
            if (start > end) return; task.warming = true; task.warmAt = performance.now() + 5000;
            const controller = new AbortController(), cancel = () => controller.abort(), deadline = setTimeout(cancel,15000);
            task.controller.signal.addEventListener('abort',cancel,{once:true});
            try {
                const response = await fetch(task.url, { headers: { Range: 'bytes=' + start + '-' + end, 'X-Stream-Buffer': '1' }, cache: 'no-store', signal: controller.signal });
                if (response.status !== 206) { await response.body?.cancel(); return; }
                const bytes = await response.arrayBuffer(); if (task.disposed || bytes.byteLength !== end - start + 1) return; task.warmCursor = end + 1;
                if (task.clientChunks) {
                    task.clientChunks.push(bytes);
                    if (task.warmCursor === task.size) { task.clientUrl = URL.createObjectURL(new Blob(task.clientChunks, { type: task.type || (current()?.kind === 'audio' ? 'audio/mpeg' : 'video/mp4') })); task.clientChunks = null;
                        if (['buffering', 'error'].includes(actual)) recoverBuffered(task); }
                }
            } catch (_) { /* Auxiliary buffering must not interrupt playback. */ }
            finally { clearTimeout(deadline); controller.abort(); task.controller.signal.removeEventListener('abort',cancel); task.warming = false; }
        }
        function align() { tail = false; delay = 0; const item = snapshot?.items.find(item => item.id === snapshot.playback.itemId && !item.unavailable); load(item, globalPosition()); }
        function sync(force = false) {
            if (!alive || denied || pageSuspended || !snapshot) return;
            const now = performance.now(), elapsed = Math.max(0, now - lastTick) / 1000; lastTick = now;
            const item = current(); if (!item) return;
            if (actual === 'error') {
                if (active?.retryAt && active.retries < 3 && now >= active.retryAt && running() && !paused && !item.unavailable) load(item, localPosition, active.retries + 1);
                return;
            }
            if (active?.ready && !locallyPaused() && running()) {
                if (media) { if (!media.paused && media.readyState >= 2) localPosition = Math.max(0, media.currentTime - (item.start || 0)); else if (actual === 'buffering' || actual === 'blocked') delay += elapsed; }
                else localPosition += elapsed;
                if (media && actual !== 'blocked') {
                    if (localPosition > active.lastPosition + .05) { active.progressAt = now; active.lastPosition = localPosition; active.retries = 0; }
                    else if (now - active.progressAt >= 30000) { if(active.retries<3)load(item,localPosition,active.retries+1);else failMedia(active,Error('STREAM_MEDIA_STALLED')); return; }
                }
                if (localPosition >= length(item)) { const followingItem = following(); if (followingItem) { load(followingItem); return; } tail = false; media?.pause(); actual = 'waiting'; update(); return; }
                const upcoming = following();
                if (upcoming && length(item) - localPosition <= Math.min(length(item), Math.max(5, loadCost + 2)) && !next) next = prepare(upcoming);
            }
            if (active?.expiresAt && active.expiresAt < Date.now() + 5000) { load(item, localPosition); return; }
            if (media && active?.ready) {
                if (locallyPaused() || !running()) { media.pause(); actual = 'paused'; }
                else if (media.paused && !active.playPending && (actual !== 'blocked' || force)) {
                    const element = media, task = active; task.playPending = true; actual = 'buffering';
                    element.play().catch(error => { if (media !== element || paused || !running() || error.name === 'AbortError') return; actual = error.name === 'NotAllowedError' ? 'blocked' : 'error'; update(); }).finally(() => { task.playPending = false; });
                }
            } else if (active?.ready) actual = locallyPaused() || !running() ? 'paused' : 'reading';
        }
        function apply(value) {
            if (!alive || denied || pageSuspended || snapshot && (value.playback.version < snapshot.playback.version || value.serverTime < snapshot.serverTime)) return;
            const previous = snapshot; snapshot = value; receivedAt = performance.now(); lastStateAt = Date.now();
            if (['offline', 'restricted'].includes(value.visibility)) { accessError(Error(value.visibility === 'offline' ? 'STREAM_OFFLINE' : 'STREAM_INVITATION_REQUIRED')); return; }
            const explicit = previous && ((value.playback.controlVersion || 0) !== (previous.playback.controlVersion || 0) || value.configVersion !== previous.configVersion || value.epoch !== previous.epoch);
            if (!previous || explicit || !current() || current()?.unavailable) align();
            else if (previous.playback.status === 'playing' && value.playback.status === 'stopped') tail = true;
            else if (value.playback.status === 'playing') tail = false;
            sync(); update(); onState?.(value);
        }
        async function poll() {
            if (!alive || denied || pageSuspended || polling) return; polling = true; const revision = accessGeneration;
            try { const value = await request('/stations/' + stationId); if (revision === accessGeneration && alive) apply(value); }
            catch (error) { if (alive && !accessError(error)) { failure = t('连接中断，正在重新读取台状态') + ' [' + error.message + ']'; update(); } } finally { polling = false; }
        }
        unsubscribe = subscribe?.(apply, error => { if (alive && !accessError(error)) { failure = t('连接中断，正在重新读取台状态') + ' [' + error.message + ']'; poll(); } });
        const timer = setInterval(() => { sync(); update(); warmCurrent(); }, 250);
        const pollTimer = setInterval(() => { if (Date.now() - lastStateAt > 25000) poll(); }, 10000);
        const reportTimer = setInterval(report, 15000); report();
        return { element: host, apply, poll, snapshot: () => snapshot, currentItemId: () => currentId, isPlaying, exitFullscreen, setBackground,
            setForeground(value) { foreground = Boolean(value); lastTick = performance.now(); sync(); update(); },
            setController(handler) { onSeek = handler; update(); },
            close() { if (!alive) return; alive = false; generation++; exitFullscreen(); unwatch(); clearTimeout(reportRetryTimer); reportController?.abort(); document.removeEventListener?.('visibilitychange',visibilityChanged); global.removeEventListener('pagehide', hidePage); global.removeEventListener('pageshow', resumePage); unsubscribe?.(); clearInterval(timer); clearInterval(pollTimer); clearInterval(reportTimer); dispose(active); clearNext(); host.remove(); notifyPlayback(); } };
    }
    global.StreamingPlayer = { create, renderRich };
})(window);
