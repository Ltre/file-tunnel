(function (global) {
    'use strict';
    const t = value => global.TunnelI18n?.t(value) || value;
    // Only this device's cursor retains loading time. Explicit global commands
    // still replace it; station permissions and the server clock are unchanged.
    function create({ stationId, watchId, request, subscribe, onState, onError, onSeek }) {
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
        let actual = 'waiting', failure = '', alive = true, denied = false, localPosition = 0, lastTick = performance.now(), delay = 0, loadCost = 1, tail = false;
        let polling = false, reporting = false, reportGeneration = 0, pageSuspended = false, accessGeneration = 0, lastStateAt = 0, unsubscribe;
        const button = (label, run) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = t(label); b.onclick = run; controls.append(b); return b; };
        const localPause = button('暂停本机观看', () => { paused = !paused; localPause.textContent = t(paused ? '恢复跟随' : '暂停本机观看'); if (paused) { media?.pause(); actual = 'paused'; } else align(); lastTick = performance.now(); sync(true); update(); });
        const sound = button('静音', () => { muted = !muted; if (media) media.muted = muted; sync(true); update(); });
        localPause.dataset.icon = '❚❚'; sound.dataset.icon = '🔇';
        const volumeLabel = document.createElement('label'); volumeLabel.textContent = t('本机音量');
        const slider = document.createElement('input'); slider.type = 'range'; slider.min = 0; slider.max = 1; slider.step = .01; slider.value = 1; slider.setAttribute('aria-label', t('本机音量'));
        slider.oninput = () => { volume = Number(slider.value); if (media) media.volume = volume; update(); }; volumeLabel.append(slider); controls.append(volumeLabel);
        const startWatching = button('开始观看', () => { paused = false; localPause.textContent = t('暂停本机观看'); if (actual === 'error') align(); lastTick = performance.now(); sync(true); update(); }); startWatching.className = 'sc-window-only';
        const enterFullscreen = button('媒体全屏', async () => {
            try { if (document.fullscreenElement === host) await document.exitFullscreen(); else if (host.requestFullscreen) await host.requestFullscreen(); else host.classList.toggle('sc-media-fullscreen'); }
            catch (_) { host.classList.toggle('sc-media-fullscreen'); }
        }); enterFullscreen.className = 'sc-window-only';
        const leaveFullscreen = button('退出全屏', () => { if (document.fullscreenElement === host) document.exitFullscreen(); host.classList.remove('sc-media-fullscreen'); }); leaveFullscreen.className = 'sc-exit-fullscreen';
        leaveFullscreen.textContent = ''; const exitIcon = document.createElement('img'); exitIcon.src = '/client/icons/quit-fullscreen.png'; exitIcon.alt = ''; exitIcon.setAttribute('aria-hidden', 'true'); leaveFullscreen.append(exitIcon); leaveFullscreen.title = t('退出全屏'); leaveFullscreen.setAttribute('aria-label', t('退出全屏'));
        const length = item => item?.duration ? item.duration - (item.start || 0) : item?.stay || 0;
        const itemKey = item => JSON.stringify([snapshot?.configVersion, item?.id, item?.kind, item?.duration, item?.start, item?.stay]);
        const current = () => snapshot?.items.find(item => item.id === currentId);
        const running = () => snapshot?.playback.status === 'playing' || tail;
        function globalPosition() { const item = snapshot?.items.find(item => item.id === snapshot.playback.itemId); return Math.min(length(item), (snapshot?.playback.position || 0) + (snapshot?.playback.status === 'playing' ? Math.max(0, performance.now() - receivedAt) / 1000 : 0)); }
        function update() {
            buffering.hidden = actual !== 'buffering';
            const selected = current(); seekBar.hidden = !snapshot?.manageable || !selected || !onSeek;
            if (selected && !dragging) { seek.max = length(selected); seek.value = Math.min(localPosition, length(selected)); seekLabel.textContent = localPosition.toFixed(1) + ' / ' + length(selected).toFixed(1) + ' s'; }
            const statuses = { playing: '正在播放', paused: '本机已暂停', buffering: '缓冲中', waiting: '等待播放', blocked: '浏览器限制播放，请点击开始观看', error: '播放失败，请重试', reading: '正在展示' };
            const silent = muted || volume === 0;
            sound.textContent = t(muted ? '取消静音' : '静音'); muteNode.hidden = !silent; muteNode.textContent = t('已静音');
            localPause.dataset.icon = paused ? '▶' : '❚❚'; sound.dataset.icon = muted ? '🔊' : '🔇';
            for (const control of [localPause, sound]) { control.title = control.textContent; control.setAttribute('aria-label', control.textContent); }
            statusNode.textContent = (failure || t(!paused && actual === 'paused' ? '全台已暂停，本机跟随' : statuses[actual] || '等待播放')) + (silent ? ' · ' + t('已静音') : '') + (delay >= 1 ? ' · ' + t('本机加载延迟（秒）') + ' ' + delay.toFixed(1) : '');
            statusNode.dataset.status = actual;
            const item = current();
            if (item && !item.duration && !paused && active?.ready) {
                const remaining = Math.max(0, item.stay - localPosition);
                countdown.hidden = false; countdown.textContent = String(Math.ceil(remaining)); countdown.dataset.position = snapshot.countdown || 'bottom-right';
                stage.style.setProperty('--sc-remaining', String(remaining / item.stay)); stage.classList.toggle('sc-edge-countdown', snapshot.countdown === 'edge');
            } else { countdown.hidden = true; stage.classList.remove('sc-edge-countdown'); }
        }
        function dispose(task) {
            if (!task || task.disposed) return; task.disposed = true; task.controller.abort();
            task.media?.pause(); task.element?.querySelectorAll?.('img,audio,video,source').forEach(node => { node.pause?.(); node.removeAttribute('src'); node.load?.(); });
            task.media?.removeAttribute('src'); task.media?.load(); if (task.element?.tagName === 'IMG') task.element.removeAttribute('src');
            if (task.clientUrl) URL.revokeObjectURL(task.clientUrl); task.clientChunks = null;
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
            try { const result = await request('/stations/' + stationId + '/report', 'POST', { watchId, itemId: currentId, position: media?.currentTime ?? localPosition, status: actual }); if (alive && revision === accessGeneration && result.station) { if (resuming === true) { pageSuspended = false; lastTick = performance.now(); } apply(result.station); } }
            catch (error) { if (alive && revision === accessGeneration) { accessError(error); onError?.(error); } } finally { if (reportRevision === reportGeneration) reporting = false; }
        }
        function unwatch() { accessGeneration++; request('/stations/' + stationId + '/unwatch', 'POST', { watchId }, { keepalive: true }).catch(() => {}); }
        const hidePage = () => { pageSuspended = true; media?.pause(); unwatch(); };
        const resumePage = event => { if (event.persisted) { watchId = initialWatchId + ':' + (++resumeCount); denied = false; report(true); } };
        global.addEventListener('pagehide', hidePage); global.addEventListener('pageshow', resumePage);
        function prepare(item) {
            const task = { item, key: itemKey(item), controller: new AbortController(), ready: false, disposed: false, started: performance.now() };
            const signal = task.controller.signal;
            const ticket = reference => request('/stations/' + stationId + '/ticket', 'POST', { itemId: item.id, reference }, { signal });
            task.promise = (async () => {
                const access = await ticket(); if (task.disposed) return; task.expiresAt = access.expiresAt; task.url = access.url; task.size = Number(access.size) || 0; task.warmCursor = 0; task.type = access.type;
                if (task.size > 0 && task.size <= 16 * 1024 * 1024) task.clientChunks = [];
                if (['audio', 'video', 'image'].includes(item.kind)) {
                    const node = document.createElement(item.kind === 'image' ? 'img' : item.kind); task.element = node;
                    if (item.kind !== 'image') { task.media = node; node.playsInline = true; node.preload = 'auto'; node.muted = muted; node.volume = volume; }
                    else { node.alt = item.name; node.decoding = 'async'; }
                    await new Promise((resolve, reject) => {
                        node.addEventListener(item.kind === 'image' ? 'load' : 'canplay', () => { if (!task.disposed) resolve(); }, { once: true });
                        node.addEventListener('error', () => reject(Error('STREAM_MEDIA_UNAVAILABLE')), { once: true });
                        signal.addEventListener('abort', () => reject(Object.assign(Error('Aborted'), { name: 'AbortError' })), { once: true });
                        node.src = access.url;
                    });
                } else {
                    const response = await fetch(access.url, { cache: 'no-store', signal }); if (!response.ok) throw Error('STREAM_SOURCE_UNAVAILABLE');
                    const body = await response.text(); if (task.disposed) return;
                    const node = document.createElement('div'); node.className = 'sc-document message-content'; task.element = node;
                    if (item.kind === 'markdown') {
                        const mapping = new Map(), refs = [...(access.references || [])];
                        const resolve = async () => { while (refs.length && !task.disposed) { const ref = refs.shift(); try { const delegated = await ticket(ref.id); mapping.set(ref.url, delegated.url); } catch (error) { if (signal.aborted) throw error; } } };
                        await Promise.all([resolve(), resolve()]); if (task.disposed) return; global.TunnelMarkdown.render(node, body, mapping);
                    } else { const pre = document.createElement('pre'); pre.textContent = body; node.append(pre); }
                }
                if (!task.disposed) task.ready = true;
            })();
            task.promise.catch(() => {}); return task;
        }
        async function load(item, position = 0, retries = 0) {
            const revision = ++generation; dispose(active); media = null; active = null; currentId = item?.id || ''; localPosition = position; failure = ''; actual = item ? 'buffering' : 'waiting';
            content.replaceChildren(); countdown.hidden = true; const started = performance.now();
            if (!item) { clearNext(); update(); return; }
            const task = next?.key === itemKey(item) && (!next.expiresAt || next.expiresAt > Date.now() + 10000) ? next : prepare(item);
            if (next !== task) clearNext(); else next = null; active = task; task.retries = retries; update();
            try {
                await task.promise; if (revision !== generation || !alive || denied || task.disposed) return;
                const wait = Math.max(0, performance.now() - started) / 1000;
                loadCost = Math.max(.25, Math.min(60, Math.max(loadCost * .7, (performance.now() - task.started) / 1000)));
                if (running() && !pageSuspended) delay += wait;
                media = task.media; content.replaceChildren(task.element); lastTick = performance.now();
                if (media) {
                    media.muted = muted; media.volume = volume; media.currentTime = Math.min((item.start || 0) + localPosition, Math.max(0, media.duration - .05));
                    media.addEventListener('playing', () => { if (active === task) { actual = 'playing'; failure = ''; lastTick = performance.now(); update(); } });
                    media.addEventListener('waiting', () => { if (active === task) { actual = 'buffering'; recoverBuffered(task); update(); } });
                    media.addEventListener('error', () => { if (active === task) { if (recoverBuffered(task)) return; actual = 'error'; failure = t('媒体无法播放，可重新读取或检查源文件'); update(); } });
                    media.addEventListener('ended', () => { if (active === task) { localPosition = length(item); sync(); } });
                    if (item.kind === 'audio') { const title = document.createElement('p'); title.className = 'message-content sc-audio-title'; title.textContent = '♪ ' + item.name; content.append(title); }
                } else actual = paused || !running() ? 'paused' : 'reading';
                sync(true); update();
            } catch (error) { if (revision !== generation || !alive || task.disposed) return; if (!accessError(error)) { actual = 'error'; task.retryAt = performance.now() + 2000 * 2 ** retries; failure = t('资源读取失败，请检查台状态与来源') + ' [' + error.message + ']'; update(); onError?.(error); } }
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
            if (!alive || denied || pageSuspended || paused || !running() || !task?.ready || !task.media || !task.size || task.clientUrl || task.warming || performance.now() < (task.warmAt || 0)) return;
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
            try {
                const response = await fetch(task.url, { headers: { Range: 'bytes=' + start + '-' + end, 'X-Stream-Buffer': '1' }, cache: 'no-store', signal: task.controller.signal });
                if (response.status !== 206) { await response.body?.cancel(); return; }
                const bytes = await response.arrayBuffer(); if (task.disposed || bytes.byteLength !== end - start + 1) return; task.warmCursor = end + 1;
                if (task.clientChunks) {
                    task.clientChunks.push(bytes);
                    if (task.warmCursor === task.size) { task.clientUrl = URL.createObjectURL(new Blob(task.clientChunks, { type: task.type || (current()?.kind === 'audio' ? 'audio/mpeg' : 'video/mp4') })); task.clientChunks = null;
                        if (['buffering', 'error'].includes(actual)) recoverBuffered(task); }
                }
            } catch (_) { /* Auxiliary buffering must not interrupt playback. */ }
            finally { task.warming = false; }
        }
        function align() { tail = false; delay = 0; const item = snapshot?.items.find(item => item.id === snapshot.playback.itemId && !item.unavailable); load(item, globalPosition()); }
        function sync(force = false) {
            if (!alive || denied || pageSuspended || !snapshot) return;
            const now = performance.now(), elapsed = Math.max(0, now - lastTick) / 1000; lastTick = now;
            const item = current(); if (!item) return;
            if (actual === 'error' && active?.retryAt && active.retries < 3 && now >= active.retryAt && running() && !paused && !item.unavailable) { load(item, localPosition, active.retries + 1); return; }
            if (active?.ready && !paused && running()) {
                if (media) { if (!media.paused && media.readyState >= 2) localPosition = Math.max(0, media.currentTime - (item.start || 0)); else if (actual === 'buffering' || actual === 'blocked') delay += elapsed; }
                else localPosition += elapsed;
                if (localPosition >= length(item)) { const followingItem = following(); if (followingItem) { load(followingItem); return; } tail = false; media?.pause(); actual = 'waiting'; update(); return; }
                const upcoming = following();
                if (upcoming && length(item) - localPosition <= Math.min(length(item), Math.max(5, loadCost + 2)) && !next) next = prepare(upcoming);
            }
            if (active?.expiresAt && active.expiresAt < Date.now() + 5000) { load(item, localPosition); return; }
            if (media && active?.ready) {
                if (paused || !running()) { media.pause(); actual = 'paused'; }
                else if (media.paused && (actual !== 'blocked' || force)) { const element = media; element.play().catch(error => { if (media !== element || paused || !running() || error.name === 'AbortError') return; actual = error.name === 'NotAllowedError' ? 'blocked' : 'error'; update(); }); }
            } else if (active?.ready) actual = paused || !running() ? 'paused' : 'reading';
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
        return { element: host, apply, poll, snapshot: () => snapshot,
            close() { if (!alive) return; alive = false; generation++; unwatch(); global.removeEventListener('pagehide', hidePage); global.removeEventListener('pageshow', resumePage); unsubscribe?.(); clearInterval(timer); clearInterval(pollTimer); clearInterval(reportTimer); dispose(active); clearNext(); host.remove(); } };
    }
    global.StreamingPlayer = { create };
})(window);
