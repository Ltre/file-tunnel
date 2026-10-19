(function (global) {
    'use strict';
    const t = value => global.TunnelI18n?.t(value) || value;
    function create({ stationId, request, subscribe, onState, onError }) {
        const host = document.createElement('section'); host.className = 'sc-player';
        host.innerHTML = '<div class="sc-stage"><div class="sc-media"></div><span class="sc-countdown"></span></div><div class="sc-local-controls"></div><p class="sc-play-status" role="status"></p>';
        const stage = host.querySelector('.sc-stage'), content = host.querySelector('.sc-media'), countdown = host.querySelector('.sc-countdown');
        const controls = host.querySelector('.sc-local-controls'), statusNode = host.querySelector('.sc-play-status');
        let snapshot, receivedAt = 0, media, currentId = '', generation = 0, paused = false, muted = true, volume = 1, actual = 'waiting', failure = '', alive = true;
        let timer, pollTimer, polling = false, lastReport = 0, ticketExpires = 0, accessGeneration = 0;
        const button = (label, run) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = t(label); b.onclick = run; controls.append(b); return b; };
        const localPause = button('暂停本机观看', () => { paused = !paused; localPause.textContent = t(paused ? '恢复跟随' : '暂停本机观看'); if (paused) { media?.pause?.(); actual = 'paused'; } else sync(true); update(); });
        const sound = button('取消静音', () => { muted = !muted; if (media) media.muted = muted; sound.textContent = t(muted ? '取消静音' : '静音'); sync(true); });
        const volumeLabel = document.createElement('label'); volumeLabel.textContent = t('本机音量');
        const slider = document.createElement('input'); slider.type = 'range'; slider.min = 0; slider.max = 1; slider.step = .01; slider.value = 1; slider.setAttribute('aria-label', t('本机音量'));
        slider.oninput = () => { volume = Number(slider.value); if (media) media.volume = volume; }; volumeLabel.append(slider); controls.append(volumeLabel);
        button('开始观看', () => { paused = false; localPause.textContent = t('暂停本机观看'); sync(true); });
        button('媒体全屏', async () => {
            try { if (document.fullscreenElement === host) await document.exitFullscreen(); else if (host.requestFullscreen) await host.requestFullscreen(); else host.classList.toggle('sc-media-fullscreen'); }
            catch (_) { host.classList.toggle('sc-media-fullscreen'); }
        });
        const leaveFullscreen = button('退出全屏', () => { if (document.fullscreenElement === host) document.exitFullscreen(); host.classList.remove('sc-media-fullscreen'); }); leaveFullscreen.className = 'sc-exit-fullscreen';
        function target() {
            const item = snapshot?.items.find(item => item.id === snapshot.playback.itemId);
            const length = item ? item.duration ? item.duration - item.start : item.stay : 0;
            return Math.min(length, (snapshot?.playback.position || 0) + (snapshot?.playback.status === 'playing' ? Math.max(0, performance.now() - receivedAt) / 1000 : 0));
        }
        function update() {
            const statuses = { playing: '正在播放', paused: '本机已暂停', buffering: '缓冲中', waiting: '等待播放', blocked: '浏览器限制播放，请点击开始观看', error: '播放失败，请重试', reading: '正在展示' };
            statusNode.textContent = failure || t(statuses[actual] || '等待播放');
            statusNode.dataset.status = actual;
            const item = snapshot?.items.find(item => item.id === currentId);
            if (item && !item.duration && !paused) {
                const remaining = Math.max(0, item.stay - target());
                countdown.hidden = false; countdown.textContent = String(Math.ceil(remaining));
                countdown.dataset.position = snapshot.countdown || 'bottom-right';
                stage.style.setProperty('--sc-remaining', String(remaining / item.stay));
                stage.classList.toggle('sc-edge-countdown', snapshot.countdown === 'edge');
            } else { countdown.hidden = true; stage.classList.remove('sc-edge-countdown'); }
            if (snapshot && Date.now() - lastReport > 5000) {
                lastReport = Date.now();
                request('/stations/' + stationId + '/report', 'POST', { itemId: currentId, position: media?.currentTime || target(), status: actual }).catch(() => {});
            }
        }
        async function ticket(itemId, reference) { return request('/stations/' + stationId + '/ticket', 'POST', { itemId, reference }); }
        async function load(item) {
            const revision = ++generation; currentId = item?.id || ''; failure = ''; actual = 'waiting';
            if (media) { media.pause?.(); media.removeAttribute('src'); media.load?.(); } media = null;
            content.replaceChildren(); countdown.hidden = true;
            if (!item) { actual = 'waiting'; update(); return; }
            try {
                const access = await ticket(item.id); if (revision !== generation || !alive) return;
                ticketExpires = access.expiresAt;
                if (item.kind === 'video' || item.kind === 'audio') {
                    const element = document.createElement(item.kind); media = element; element.playsInline = true; element.preload = 'metadata'; element.muted = muted; element.volume = volume;
                    element.addEventListener('loadedmetadata', () => { if (revision === generation) sync(true); });
                    element.addEventListener('playing', () => { if (revision !== generation) return; actual = 'playing'; failure = ''; update(); });
                    element.addEventListener('waiting', () => { if (revision !== generation) return; actual = 'buffering'; update(); });
                    element.addEventListener('error', () => { if (revision !== generation) return; actual = 'error'; failure = t('媒体无法播放，可重新读取或检查源文件'); update(); });
                    element.addEventListener('ended', () => { if (revision !== generation) return; actual = 'waiting'; update(); poll(); });
                    element.src = access.url; content.append(element);
                    if (item.kind === 'audio') { const title = document.createElement('p'); title.className = 'message-content sc-audio-title'; title.textContent = '♪ ' + item.name; content.append(title); }
                } else if (item.kind === 'image') {
                    const img = document.createElement('img'); img.alt = item.name; img.onload = () => { if (revision === generation) { actual = paused ? 'paused' : 'reading'; update(); } };
                    img.onerror = () => { if (revision === generation) { actual = 'error'; failure = t('图片无法读取，请检查来源'); update(); } }; img.src = access.url; content.append(img);
                } else {
                    const response = await fetch(access.url, { cache: 'no-store' }); if (!response.ok) throw Error('STREAM_SOURCE_UNAVAILABLE');
                    const body = await response.text(); if (revision !== generation || !alive) return;
                    const documentNode = document.createElement('div'); documentNode.className = 'sc-document message-content';
                    if (item.kind === 'markdown') {
                        const mapping = new Map();
                        for (const ref of access.references || []) {
                            try {
                                const delegated = await ticket(item.id, ref.id); if (revision !== generation || !alive) return;
                                mapping.set(ref.url, delegated.url);
                            } catch (_) { /* A missing attachment does not invalidate the readable document. */ }
                        }
                        global.TunnelMarkdown.render(documentNode, body, mapping);
                    } else { const pre = document.createElement('pre'); pre.textContent = body; documentNode.append(pre); }
                    content.append(documentNode); actual = paused ? 'paused' : 'reading';
                }
                sync(true); update();
            } catch (error) { if (revision !== generation || !alive) return; actual = 'error'; failure = t('资源读取失败，请检查台状态与来源') + ' [' + error.message + ']'; update(); onError?.(error); }
        }
        function sync(force = false) {
            if (!snapshot || paused) return;
            const item = snapshot.items.find(item => item.id === snapshot.playback.itemId);
            if (item?.id !== currentId || force && actual === 'error' || ticketExpires && ticketExpires < Date.now() + 5000) { load(item); return; }
            if (media && media.readyState >= 1) {
                const position = (item.start || 0) + target();
                const difference = position - media.currentTime;
                if (force || Math.abs(difference) > 2) media.currentTime = Math.min(position, Math.max(0, media.duration - .05));
                media.playbackRate = Math.abs(difference) > .3 ? difference > 0 ? 1.02 : .98 : 1;
                if (snapshot.playback.status === 'playing') {
                    if (media.paused) { const element = media; element.play().catch(error => { if (media !== element || paused || snapshot.playback.status !== 'playing' || error.name === 'AbortError') return; actual = error.name === 'NotAllowedError' ? 'blocked' : 'error'; update(); }); }
                } else { media.pause(); actual = 'paused'; }
            }
        }
        function apply(value) {
            if (snapshot && value.playback.version < snapshot.playback.version) return;
            snapshot = value; receivedAt = performance.now(); sync(); update(); onState?.(value);
        }
        async function poll() {
            if (!alive || polling) return; polling = true; const accessAtRequest = accessGeneration;
            try { const value = await request('/stations/' + stationId); if (accessAtRequest === accessGeneration && alive) apply(value); }
            catch (error) {
                failure = t('连接中断，正在重新读取台状态') + ' [' + error.message + ']';
                if (['STREAM_KICKED', 'STREAM_INVITATION_REQUIRED', 'STREAM_OFFLINE', 'STREAM_NOT_FOUND'].includes(error.message)) {
                    accessGeneration++; generation++; currentId = ''; content.replaceChildren(); media?.pause(); media = null; actual = 'waiting';
                    if (snapshot) onState?.({ ...snapshot, visibility: error.message === 'STREAM_OFFLINE' ? 'offline' : 'restricted', items: [], playback: { ...snapshot.playback, status: 'stopped' } });
                    onError?.(error);
                }
                update();
            } finally { polling = false; }
        }
        const unsubscribe = subscribe?.(apply, error => { failure = t('连接中断，正在重新读取台状态') + ' [' + error.message + ']'; poll(); });
        timer = setInterval(() => { sync(); update(); }, 250); pollTimer = setInterval(poll, 10000);
        return { element: host, apply, poll, snapshot: () => snapshot,
            close() { alive = false; generation++; unsubscribe?.(); clearInterval(timer); clearInterval(pollTimer); media?.pause(); media?.removeAttribute('src'); host.remove(); } };
    }
    global.StreamingPlayer = { create };
})(window);
