'use strict';
(function attachTelegramTargetForward(global) {
    const componentStates = new Map();
    const components = new Set();
    const IDLE_REFRESH_MS = 60000;
    const ACTIVE_REFRESH_MS = 1000;
    let outsideDismissBound = false;

    function normalizeTargets(targets) {
        return (targets || []).map(item => typeof item === 'string' ? { target:item, remark:'' } : {
            target:String(item?.target || ''), remark:String(item?.remark || '')
        }).filter(item => item.target);
    }

    function bindOutsideDismiss() {
        if (outsideDismissBound) return;
        outsideDismissBound = true;
        document.addEventListener('pointerdown', event => {
            for (const details of [...components]) {
                if (!details.isConnected) { components.delete(details); continue; }
                if (details.open && !details.contains(event.target)) details.open = false;
            }
        }, true);
        document.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            for (const details of components) if (details.open) details.open = false;
        });
    }

    function getState(root, task) {
        const key = `${root}:${task.id}`;
        if (!componentStates.has(key)) componentStates.set(key, { busy:false, targets:[], loaded:false, message:'', views:new Set(), job:null });
        return componentStates.get(key);
    }

    function create(task, root, request) {
        const state = getState(root, task);
        const details = document.createElement('details');
        details.className = 'telegram-target-forward';
        components.add(details);
        bindOutsideDismiss();
        const summary = document.createElement('summary');
        summary.textContent = '转发到指定的Telegram目标';
        const menu = document.createElement('div');
        menu.className = 'telegram-target-forward-menu';
        const variantLabel = document.createElement('label');
        variantLabel.className = 'telegram-target-variant';
        variantLabel.hidden = true;
        const variant = document.createElement('select');
        variant.setAttribute('aria-label', '转发文件版本');
        for (const [value, text] of [['original', '原版'], ['audio-repaired', '音轨修正版']]) {
            const option = document.createElement('option'); option.value = value; option.textContent = text; variant.append(option);
        }
        variant.value = 'original';
        variantLabel.append(document.createTextNode('转发版本'), variant);
        const input = document.createElement('textarea');
        input.className = 'telegram-target-input';
        input.placeholder = '@用户名、公开 t.me/用户名链接或数字 chat ID；多个目标用换行或逗号分隔';
        input.rows = 5; input.value = state.draftTargets || '';
        input.oninput = () => { state.draftTargets = input.value; };
        input.autocomplete = 'off';
        const history = document.createElement('div');
        history.className = 'telegram-target-history';
        const caption = document.createElement('textarea');
        caption.className = 'telegram-target-caption';
        caption.maxLength = 1024;
        caption.placeholder = '消息 caption 备注（可选，最多 1024 字符）';
        caption.value = task.remark || '';
        const videoPreviewLabel = document.createElement('label');
        videoPreviewLabel.className = 'telegram-target-preview-option';
        const videoPreview = document.createElement('input');
        videoPreview.type = 'checkbox';
        videoPreview.className = 'telegram-target-video-preview';
        videoPreviewLabel.append(videoPreview, document.createTextNode('支持视频预览（发送可直接播放的视频，不重新压缩）'));
        const send = document.createElement('button');
        send.type = 'button';
        send.className = 'telegram-target-send';
        send.textContent = '发送原文件';
        variant.onchange = () => { send.textContent = variant.value === 'audio-repaired' ? '发送音轨修正版' : '发送原文件'; };
        const status = document.createElement('div');
        status.className = 'telegram-target-status';
        status.setAttribute('role', 'status');
        status.textContent = state.message;
        const mini = document.createElement('span'); mini.className = 'telegram-target-mini';
        summary.append(mini);
        const progress = document.createElement('progress'); progress.max = 100; progress.hidden = true;
        const targetResults = document.createElement('div'); targetResults.className = 'telegram-target-results';
        function paint() {
            const job = state.job, active = job && ['queued','running'].includes(job.state);
            mini.className = 'telegram-target-mini' + (active ? ' is-running' : '');
            mini.textContent = job ? `${job.progress || 0}% · ${job.completedTargets}/${job.targets.length} 已发送` : '';
            send.disabled = state.busy || active;
            if (!job) { status.textContent = state.message; return; }
            status.textContent = `${job.detail || job.state} · ${job.progress || 0}% · 已完成 ${job.completedTargets}/${job.targets.length} 个目标${job.currentTarget ? ' · ' + job.currentTarget : ''}${state.pollError ? ' · ' + state.pollError : ''}`;
            if (state.busy || state.submitError) status.textContent = state.submitError || state.message;
            progress.hidden = false; progress.value = job.progress || 0; targetResults.replaceChildren();
            const labels = { cancelled:'已取消，未发送', queued:'等待发送', running:'正在发送', completed:'发送成功', failed:'发送失败，请先检查目标是否已收到', uncertain:'结果未确认，请先检查 Telegram' };
            for (const item of job.targets) { const row = document.createElement('div'); row.textContent = `${item.target} · ${labels[item.state] || item.state}${item.state === 'running' ? ' ' + (item.progress || 0) + '%' : ''}${item.error ? ' · ' + item.error : ''}${item.rollbackState ? ' · ' + (item.rollbackState==='retracted'?'已撤回':'撤回失败：'+item.rollbackError) : ''}`; targetResults.append(row); }
        }
        const cancel=document.createElement('button');cancel.type='button';cancel.className='telegram-target-cancel';cancel.textContent='取消发送';cancel.hidden=true;
        cancel.onclick=async()=>{if(!state.job)return;cancel.disabled=true;try{const result=await request('/api/telegram-forward-jobs/'+state.job.id+'/cancel',{method:'POST'});state.job=result.job;updateViews(state);schedulePoll(state);}catch(error){state.submitError='取消失败：'+error.message;updateViews(state);}finally{cancel.disabled=Boolean(state.job?.cancelRequested);}};
        const previousPaint=paint;const paintWithCancel=()=>{previousPaint();cancel.hidden=!state.job||!['queued','running'].includes(state.job.state);cancel.disabled=Boolean(state.job?.cancelRequested);cancel.textContent=state.job?.cancelRequested?'正在取消…':'取消发送';};
        state.views.add({ details, paint:paintWithCancel });
        state.request = request; state.source = root.includes('youtube') ? 'youtube' : 'sns'; state.taskId = task.id;
        paintWithCancel();

        function renderTargets() {
            history.replaceChildren();
            if (!state.targets.length) {
                const empty = document.createElement('small');
                empty.textContent = '尚无历史目标，发送成功后会自动记住。';
                history.append(empty);
                return;
            }
            for (const record of state.targets) {
                const target = record.target;
                const row = document.createElement('div');
                row.className = 'telegram-target-history-row';
                const choose = document.createElement('button');
                choose.type = 'button';
                choose.textContent = target;
                choose.title = `选择 ${target}`;
                choose.onclick = () => { const values = parseTargets(input.value); if (!values.includes(target)) values.push(target); input.value = values.join('\n'); state.draftTargets = input.value; input.focus(); };
                const remark = document.createElement('input');
                remark.className = 'telegram-target-remark';
                remark.maxLength = 100;
                remark.placeholder = '目标备注';
                remark.value = record.remark || '';
                remark.setAttribute('aria-label', `${target} 的备注`);
                remark.onchange = async () => {
                    remark.disabled = true;
                    try {
                        const result = await request('/api/telegram-forward-targets', {
                            method:'PATCH', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ target, remark:remark.value })
                        });
                        state.targets = normalizeTargets(result.targets);
                        state.message = status.textContent = '目标备注已保存。';
                        renderTargets();
                    } catch (error) {
                        state.message = status.textContent = `备注保存失败：${error.message}`;
                        remark.disabled = false;
                    }
                };
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'telegram-target-remove';
                remove.textContent = '×';
                remove.title = `删除历史目标 ${target}`;
                remove.onclick = async event => {
                    event.stopPropagation();
                    remove.disabled = true;
                    try {
                        const result = await request('/api/telegram-forward-targets/delete', {
                            method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ target })
                        });
                        state.targets = normalizeTargets(result.targets);
                        renderTargets();
                    } catch (error) {
                        state.message = status.textContent = `删除失败：${error.message}`;
                        remove.disabled = false;
                    }
                };
                row.append(choose, remark, remove);
                history.append(row);
            }
        }

        async function refreshVariants() {
            variantLabel.hidden = true;
            variant.value = 'original'; variant.onchange();
            if (task.status !== 'completed' || !String(task.downloadSections || '').trim() || task.asMusic || ['audio', 'song'].includes(task.mediaType)) return;
            try {
                const result = await request(`${root}/tasks/${encodeURIComponent(task.id)}/audio-repair/status`);
                variantLabel.hidden = !(result.status === 'completed' && result.forwardAvailable === true);
            } catch (_) { /* No verified repair: keep forwarding the original file. */ }
        }

        details.addEventListener('toggle', async () => {
            if (!details.open) return;
            for (const component of components) if (component !== details && component.open) component.open = false;
            const variantsReady = refreshVariants();
            refreshJobs(state, { force: true }).catch(() => {});
            if (state.loaded) { await variantsReady; return; }
            status.textContent = '正在读取历史目标…';
            try {
                const result = await request('/api/telegram-forward-targets');
                state.targets = normalizeTargets(result.targets);
                state.loaded = true;
                status.textContent = state.message;
                renderTargets();
            } catch (error) {
                status.textContent = `历史读取失败：${error.message}`;
            }
            await variantsReady;
        });

        send.onclick = async () => {
            if (state.busy || (state.job && ['queued','running'].includes(state.job.state))) return;
            const targets = parseTargets(input.value);
            if (!targets.length) { status.textContent = '请先填写或选择 Telegram 目标。'; input.focus(); return; }
            if (targets.length > 50) { status.textContent = '一次最多发送 50 个目标。'; return; }
            const fileVariant = variantLabel.hidden ? 'original' : variant.value;
            const payload = { targets, caption:caption.value, fileVariant, supportVideoPreview:videoPreview.checked };
            const signature = JSON.stringify(payload);
            if (state.submission !== signature) { state.submission = signature; state.requestId = global.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2); }
            state.busy = true; state.submitError = ''; state.message = '正在提交后台发送队列…'; updateViews(state);
            send.disabled = input.disabled = caption.disabled = videoPreview.disabled = variant.disabled = true;
            try {
                const result = await request(root + '/tasks/' + encodeURIComponent(task.id) + '/telegram-forward', {
                    method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ ...payload, requestId:state.requestId })
                });
                if (result.job) { state.job = result.job; schedulePoll(state); }
                else { // Compatibility with an older server during a rolling update.
                    state.message = '已将' + (result.fileVariant === 'audio-repaired' ? '音轨修正版' : '原文件') + '发送到 ' + (result.target || targets.join('、')) + '。';
                }
                state.submission = null;
            } catch (error) { state.submitError = state.message = '提交失败：' + error.message + '；可以重试同一请求。'; }
            finally {
                state.busy = false;
                input.disabled = caption.disabled = videoPreview.disabled = variant.disabled = false;
                updateViews(state);
            }
        };

        menu.append(variantLabel, input, history, caption, videoPreviewLabel, send, status, progress, targetResults, cancel);
        details.append(summary, menu);
        renderTargets();
        refreshJobs(state).catch(() => {});
        return details;
    }

    function parseTargets(value) {
        return [...new Map(String(value).split(/[\s,，;；]+/).filter(Boolean).map(item => [item.toLowerCase(), item])).values()];
    }
    function updateViews(state) {
        for (const view of state.views) { if (!view.details.isConnected) state.views.delete(view); else view.paint(); }
    }
    async function refreshJobs(state, { force = false } = {}) {
        if (state.polling) return;
        const active = state.job && ['queued','running'].includes(state.job.state);
        if (!force && state.jobsCheckedAt !== undefined && Date.now() - state.jobsCheckedAt < (active ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS)) return;
        state.polling = true;
        state.jobsCheckedAt = Date.now();
        const before = state.job;
        try {
            const result = await state.request('/api/telegram-forward-jobs?source=' + state.source + '&taskId=' + encodeURIComponent(state.taskId));
            if (state.job === before && result.jobs?.length) state.job = result.jobs[0];
            state.pollError = '';
            updateViews(state);
        } catch (error) { if (state.job && ['queued','running'].includes(state.job.state)) { state.pollError = '进度暂时读取失败，后台发送仍继续'; updateViews(state); } }
        finally { state.polling = false; schedulePoll(state); }
    }
    function schedulePoll(state) {
        if (state.timer || typeof setTimeout !== 'function' || !state.job || !['queued','running'].includes(state.job.state)) return;
        state.timer = setTimeout(() => { state.timer = null; refreshJobs(state, { force: true }); }, ACTIVE_REFRESH_MS);
    }

    function busy(container = document) {
        return [...componentStates.values()].some(state => state.busy) || Boolean(container?.querySelector?.('.telegram-target-forward[open]'));
    }

    global.TelegramTargetForward = { create, busy };
})(window);
