(function (global) {
    'use strict';
    const t = value => global.TunnelI18n?.t(value) || value;
    let current;
    function open(options) {
        if (current) close();
        const overlay = document.createElement('div'); overlay.className = 'account-overlay';
        const panel = document.createElement('section'); panel.className = 'account-panel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true');
        const heading = document.createElement('h2'); heading.textContent = t(options.choose ? '选择转存目标账号' : '登录 / 移除账号'); panel.setAttribute('aria-label', heading.textContent);
        const status = document.createElement('p'); status.setAttribute('role', 'status');
        const list = document.createElement('div'), signIn = document.createElement('div'), actions = document.createElement('div');
        let entries = [], selected = options.requiredId || options.currentAccount(), loading = false, generation = 0, loadController;
        const button = (text, run) => {
            const node = document.createElement('button'); node.type = 'button'; node.textContent = t(text);
            node.onclick = async () => { if (node.disabled) return; node.disabled = true; try { await run(); } catch (error) { status.textContent = t('账号操作未完成，请重试') + ' [' + error.message + ']'; } finally { node.disabled = false; } }; return node;
        };
        const result = new Promise(resolve => {
            current = { overlay, resolve, options, signIn, reload, cancelLoad: () => loadController?.abort() };
            const dismiss = button('×', () => close()); dismiss.className = 'account-close'; dismiss.setAttribute('aria-label', t('关闭')); dismiss.title = t('关闭'); panel.append(dismiss);
            if (options.choose) actions.append(button('选择此账号', async () => {
                if (loading) throw Error('ACCOUNT_LOADING');
                const entry = entries.find(item => item.identity?.id === selected);
                if (!entry || entry.reauthRequired || options.requiredId && selected !== options.requiredId) throw Error('LOGIN_REQUIRED');
                if (await options.select(entry.identity.id) === false) return; if (current?.overlay === overlay) close(entry.identity);
            }));
        });
        panel.append(heading, status, list, signIn, actions); overlay.append(panel); document.body.append(overlay);
        history.pushState({ ...(history.state || {}), globalAccountPanel: true }, '', location.href);
        reload(); return result;
        async function reload() {
            if (!overlay.isConnected) return; const revision = ++generation; loading = true; status.textContent = t('正在读取账号状态…');
            loadController?.abort(); const controller = loadController = new AbortController();
            const timer = setTimeout(() => controller.abort(), 20000);
            try {
                const data = await options.load(controller.signal); if (revision !== generation || !overlay.isConnected) return;
                if (controller.signal.aborted) throw Error('ACCOUNT_LOAD_TIMEOUT');
                entries = data.accounts || []; selected ||= data.identity?.id || ''; list.replaceChildren(); signIn.replaceChildren(); status.textContent = options.prompt || '';
                for (const entry of entries) {
                    const user = entry.identity; if (!user) continue;
                    const row = document.createElement('div'); row.className = 'account-row';
                    const select = button(user.name || user.username || user.id, async () => {
                        if (entry.reauthRequired) { await options.reauthenticate?.(user, signIn, data.status); return; }
                        if (options.requiredId && user.id !== options.requiredId) { status.textContent = t('请先添加或重新登录一个有效的网盘账号'); return; }
                        if (options.choose) { selected = user.id; list.querySelectorAll('[aria-pressed]').forEach(node => node.setAttribute('aria-pressed', String(node === select))); }
                        else { if (await options.select(user.id) === false) return; if (current?.overlay === overlay) close(user); }
                    }); select.classList.add('message-content'); select.textContent = user.name || user.username || user.id;
                    select.setAttribute('aria-pressed', String(user.id === (options.choose ? selected : options.currentAccount())));
                    const label = document.createElement('small'); label.textContent = t(entry.reauthRequired ? '需要重新登录' : user.id === options.currentAccount() ? '当前账号' : '');
                    let confirming = false;
                    const cancel = button('取消', () => { confirming = false; cancel.hidden = true; exit.textContent = t('退出'); status.textContent = ''; }); cancel.hidden = true;
                    const exit = button('退出', async () => {
                        if (!confirming) { confirming = true; cancel.hidden = false; exit.textContent = t('确认退出'); status.textContent = t('退出只会清除本浏览器的网盘登录状态，不会删除网盘文件。'); return; }
                        await options.logout(user.id); await reload();
                    });
                    row.append(select, label, exit, cancel); list.append(row);
                }
                if (!entries.length && !options.prompt) status.textContent = t('尚未登录账号');
                options.renderSignIn(signIn, data.status);
                if (!options.choose && entries.length && options.offline) {
                    const offline = button('使用离线身份', async () => {
                        if (await options.offline() === false) return; close();
                        const message = t('已使用离线身份，部分需要登录的功能将无法使用。');
                        if (global.showAppToast) global.showAppToast(message); else global.alert(message);
                    });
                    const add = signIn.querySelector('button');
                    if (add) { const row = document.createElement('div'); row.className = 'account-sign-actions'; add.before(row); row.append(add, offline); } else signIn.append(offline);
                }
            } catch (error) { if (revision === generation && overlay.isConnected) { status.textContent = (options.prompt ? options.prompt + '\n' : '') + t(controller.signal.aborted ? '读取账号状态超时，请检查连接后重试' : '账号操作未完成，请重试') + ' [' + error.message + ']'; list.replaceChildren(button('重新读取账号', reload)); } }
            finally { clearTimeout(timer); if (revision === generation) loading = false; }
        }
    }
    function close(value = null) {
        if (!current) return; const previous = current; current = null;
        previous.cancelLoad(); previous.options.cancelSignIn?.(previous.signIn); previous.overlay.remove(); previous.resolve(value);
        if (history.state?.globalAccountPanel) { const next = { ...history.state }; delete next.globalAccountPanel; history.replaceState(next, '', location.href); }
    }
    global.addEventListener('popstate', event => { if (current) { close(); event.stopImmediatePropagation(); } }, true);
    document.addEventListener('keydown', event => { if (current && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); } }, true);
    function completeSignIn(target, identity) {
        if (identity && target && current?.signIn === target) close(identity);
    }
    global.AccountUI = { open, close, completeSignIn, isOpen: () => Boolean(current), refresh: () => current?.reload() };
})(window);
