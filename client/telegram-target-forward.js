'use strict';
(function attachTelegramTargetForward(global) {
    const componentStates = new Map();

    function getState(root, task) {
        const key = `${root}:${task.id}`;
        if (!componentStates.has(key)) componentStates.set(key, { busy:false, targets:[], loaded:false, message:'' });
        return componentStates.get(key);
    }

    function create(task, root, request) {
        const state = getState(root, task);
        const details = document.createElement('details');
        details.className = 'telegram-target-forward';
        const summary = document.createElement('summary');
        summary.textContent = '转发到指定的Telegram目标';
        const menu = document.createElement('div');
        menu.className = 'telegram-target-forward-menu';
        const input = document.createElement('input');
        input.className = 'telegram-target-input';
        input.placeholder = '@频道用户名、t.me/用户名或数字 ID';
        input.autocomplete = 'off';
        const history = document.createElement('div');
        history.className = 'telegram-target-history';
        const caption = document.createElement('textarea');
        caption.className = 'telegram-target-caption';
        caption.maxLength = 1024;
        caption.placeholder = '消息 caption 备注（可选，最多 1024 字符）';
        caption.value = task.remark || '';
        const send = document.createElement('button');
        send.type = 'button';
        send.className = 'telegram-target-send';
        send.textContent = '发送原文件';
        const status = document.createElement('div');
        status.className = 'telegram-target-status';
        status.setAttribute('role', 'status');
        status.textContent = state.message;

        function renderTargets() {
            history.replaceChildren();
            if (!state.targets.length) {
                const empty = document.createElement('small');
                empty.textContent = '尚无历史目标，发送成功后会自动记住。';
                history.append(empty);
                return;
            }
            for (const target of state.targets) {
                const row = document.createElement('div');
                row.className = 'telegram-target-history-row';
                const choose = document.createElement('button');
                choose.type = 'button';
                choose.textContent = target;
                choose.title = `选择 ${target}`;
                choose.onclick = () => { input.value = target; input.focus(); };
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
                        state.targets = result.targets || [];
                        renderTargets();
                    } catch (error) {
                        state.message = status.textContent = `删除失败：${error.message}`;
                        remove.disabled = false;
                    }
                };
                row.append(choose, remove);
                history.append(row);
            }
        }

        details.addEventListener('toggle', async () => {
            if (!details.open || state.loaded) return;
            status.textContent = '正在读取历史目标…';
            try {
                const result = await request('/api/telegram-forward-targets');
                state.targets = result.targets || [];
                state.loaded = true;
                status.textContent = state.message;
                renderTargets();
            } catch (error) {
                status.textContent = `历史读取失败：${error.message}`;
            }
        });

        send.onclick = async () => {
            if (state.busy) return;
            const target = input.value.trim();
            if (!target) { status.textContent = '请先填写或选择 Telegram 目标。'; input.focus(); return; }
            state.busy = true;
            send.disabled = input.disabled = caption.disabled = true;
            state.message = status.textContent = '正在向 Telegram 发送原文件，请保持页面打开…';
            try {
                const result = await request(`${root}/tasks/${encodeURIComponent(task.id)}/telegram-forward`, {
                    method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ target, caption:caption.value })
                });
                input.value = result.target || target;
                state.targets = [input.value, ...state.targets.filter(item => item !== input.value)];
                state.loaded = true;
                renderTargets();
                state.message = status.textContent = `已将原文件发送到 ${input.value}${result.messageId ? `（消息 ${result.messageId}）` : ''}。`;
            } catch (error) {
                state.message = status.textContent = `发送失败：${error.message}`;
            } finally {
                state.busy = false;
                send.disabled = input.disabled = caption.disabled = false;
            }
        };

        menu.append(input, history, caption, send, status);
        details.append(summary, menu);
        renderTargets();
        return details;
    }

    function busy(container = document) {
        return [...componentStates.values()].some(state => state.busy) || Boolean(container?.querySelector?.('.telegram-target-forward[open]'));
    }

    global.TelegramTargetForward = { create, busy };
})(window);
