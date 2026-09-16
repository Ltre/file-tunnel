'use strict';
// Installed by disk-directory-menu-fixture.cjs; open its /controls URL.
const fs = require('node:fs'), path = require('node:path');
module.exports = function install(app, root) {
    let report = { status: 'pending' };
    app.get('/controls', (_req, res) => {
        let html = fs.readFileSync(path.join(root, 'pages/index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
        html = html.replace('</body>', '<script src="/client/disk-client.js"></script><script src="/client/disk-ui.js"></script><script src="/control-check.js"></script></body>'); res.type('html').send(html);
    });
    app.get('/control-report', (_req, res) => res.json(report));
    app.post('/control-report', (req, res) => { report = req.body; console.log(JSON.stringify(report)); res.json({ ok: true }); });
    app.get('/control-check.js', (_req, res) => {
        const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
        const functions = source.slice(source.indexOf('function normalizeControlCenterOrder('), source.indexOf('function showTunnelRemarkDialog(')) + '\n' +
            source.slice(source.indexOf('function applyTheme('), source.indexOf('function isTunnelOwner('));
        const helperSource = fs.readFileSync(__filename, 'utf8');
        const runSource = helperSource.slice(helperSource.lastIndexOf(['async', 'function run()'].join(' ')));
        res.type('js').send(`const state={sessionId:'fixture'},getAllFromStore=async()=>Array.from({length:80},(_,i)=>({sessionId:i?'session-'+i:'fixture',shortCode:String(i).padStart(5,'0')})),escapeHtml=String,normalizeLocalShortCode=String,historyLog=()=>{},hasActiveTransferTasks=()=>false;\n${functions}\n(${runSource})();`);
    });
};
async function run() {
    const results = [], alerts = [], sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const assert = (value, message) => { if (!value) throw Error(message); };
    const until = async check => { for (let n = 0; n < 200; n++) { if (check()) return; await sleep(25); } throw Error('等待界面超时'); };
    const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    window.alert = message => alerts.push(message);
    window.TelegramDriveCache = { status: async () => ({}) };
    try {
        await post('/fixture/reset'); await post('/fixture/seed'); await post('/fixture/identity', { enabled: false });
        document.getElementById('appShell').hidden = false; document.getElementById('tunnelTopbar').hidden = false;
        window.DiskUI.init({ showAppToast() {} }); initThemeSwitcher(); let loadingCalls = 0;
        const activity = window.DiskClient.withActivity; window.DiskClient.withActivity = (...args) => { loadingCalls++; return activity(...args); };
        await window.DiskUI.open(); assert(!document.getElementById('telegramDriveAuth').hidden && document.getElementById('telegramDriveWorkspace').hidden, '未登录没有显示登录界面');
        assert(loadingCalls === 0 && document.getElementById('diskLoading').hidden, '未登录打开出现居中 Loading'); results.push('未登录打开网盘不产生居中 Loading');
        window.DiskUI.close(); await post('/fixture/identity', { enabled: true });
        localStorage.removeItem('telegramDriveSaveDirectory:directory-fixture');
        const saving = window.DiskUI.chooseDirectory({ title: '独立保存选择器', userId: 'directory-fixture' });
        await until(() => !document.getElementById('telegramDriveDialog').hidden);
        assert(document.getElementById('telegramDriveOverlay').hidden, '独立选择器打开了整个网盘');
        const folder = document.querySelector('[data-folder-path="已有目录"]'); folder.click();
        assert(folder.closest('details').open && document.querySelector('[data-folder-path="已有目录/子目录"]').getBoundingClientRect().height > 0, 'PC 点击目录没有展开子目录');
        [...document.querySelectorAll('#telegramDriveDialogActions button')].at(-1).click(); assert(await saving === '已有目录', '目录选择错误');
        await sleep(50);
        const again = window.DiskUI.chooseDirectory({ userId: 'directory-fixture' }); await until(() => !document.getElementById('telegramDriveDialog').hidden);
        assert(document.querySelector('#telegramDriveDialogBody input').value === '/已有目录', '未记住保存目录');
        document.getElementById('telegramDriveDialogCloseBtn').click(); assert(await again === null, '关闭没有取消选择'); await sleep(50);
        results.push('独立目录选择器、PC 点击展开、保存目录记忆');
        await window.DiskUI.open();
        document.getElementById('telegramDriveBottomMenuBtn').click(); assert(document.getElementById('telegramDriveItemMenu').textContent.includes('当前目录属性'), '底部空白菜单错误');
        history.back(); await until(() => document.getElementById('telegramDriveItemMenu').hidden); results.push('底部菜单按钮及返回关闭保持网盘');
        const row = [...document.querySelectorAll('#telegramDriveList .telegram-drive-item')].find(item => item.textContent.includes('拖动测试.txt'));
        const rect = row.getBoundingClientRect(), pointer = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 55, pointerType: 'mouse', isPrimary: true, button: 0, clientX: x, clientY: y });
        row.dispatchEvent(pointer('pointerdown', rect.left + 50, rect.top + 20)); row.dispatchEvent(pointer('pointermove', rect.left + 100, rect.top + 20));
        assert(document.querySelector('.telegram-drive-touch-drag'), 'PC 拖动未进入移动模式');
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); assert(!document.querySelector('.telegram-drive-touch-drag'), '取消拖动没有清理'); results.push('PC 指针拖动及 Escape 取消');
        window.DiskUI.close(); localStorage.removeItem('tunnelControlCenterOrder');
        const calls = {};
        for (const id of ['mobileForceRefreshBtn', 'magnetCacheBtn', 'cycleThemeBtn', 'tunnelSettingsBtn', 'leaveTunnelPanelBtn', 'scanTunnelCodeBtn', 'receiveLightBtn', 'resourceBrowserBtn', 'notificationCenterBtn', 'telegramDriveBtn']) document.getElementById(id).addEventListener('click', () => { calls[id] = (calls[id] || 0) + 1; });
        await showJoinedSessionSwitcher(); let center = document.querySelector('.control-center-overlay');
        assert(center.querySelectorAll('[data-control-tile]').length === 10, '控制中心磁贴不完整');
        const panel = center.querySelector('[data-control-panel]'), panelRect = panel.getBoundingClientRect(); assert(panelRect.height <= innerHeight * .6 + 1, '隧道面板超过可视高度60%');
        const themeBefore = document.body.dataset.theme;
        center.querySelector('[data-control-tile="theme"]').click();
        assert(center.isConnected && !calls.cycleThemeBtn && document.getElementById('themeQuickMenu').hidden && document.body.dataset.theme !== themeBefore, '主题磁贴没有在控制中心内轮换主题或错误打开竖条');
        center.remove();
        await showJoinedSessionSwitcher(); center = document.querySelector('.control-center-overlay');
        center.querySelector('[data-control-tile="magnet"]').click(); assert(!center.isConnected && calls.magnetCacheBtn === 1, '磁链入口未调用或没有关闭控制中心'); results.push('十项磁贴、主题原地轮换、磁链关闭及面板高度');
        await showJoinedSessionSwitcher(); center = document.querySelector('.control-center-overlay');
        const tile = center.querySelector('[data-control-tile="disk"]'), start = tile.getBoundingClientRect(), destination = center.querySelector('[data-control-panel]').getBoundingClientRect();
        tile.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 88, pointerType: 'mouse', isPrimary: true, button: 0, clientX: start.left + 10, clientY: start.top + 10 }));
        assert(!center.querySelector('.control-center-drag-label').hidden && center.querySelector('.control-center-drag-label').textContent === '当前选中：Telegram网盘', '拖动提示缺失');
        window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 88, clientX: destination.left + 10, clientY: destination.bottom - 5 }));
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 88 }));
        assert(center.querySelector('[data-control-side="after"] [data-control-tile="disk"]') && center.querySelector('.control-center-drag-label').hidden, '无法拖到面板下方或松开没有清理提示');
        center.remove(); await showJoinedSessionSwitcher(); center = document.querySelector('.control-center-overlay');
        assert(center.querySelector('[data-control-side="after"] [data-control-tile="disk"]'), '控制中心排序没有保存');
        results.push('磁贴拖到隧道面板下方、固定提示及排序记忆');
        const touchTile = center.querySelector('[data-control-tile="disk"]'), touchRect = touchTile.getBoundingClientRect(), panelTop = center.querySelector('[data-control-panel]').getBoundingClientRect();
        touchTile.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 99, pointerType: 'touch', isPrimary: true, button: 0, clientX: touchRect.left + 10, clientY: touchRect.top + 10 }));
        await sleep(550); assert(!center.querySelector('.control-center-drag-label').hidden, '触屏长按未进入拖动');
        window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 99, pointerType: 'touch', clientX: panelTop.left + 5, clientY: panelTop.top + 5 }));
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 99, pointerType: 'touch' }));
        assert(center.querySelector('[data-control-side="before"] [data-control-tile="disk"]') && center.querySelector('.control-center-drag-label').hidden, '触屏无法移到面板上方'); results.push('触屏长按拖动跨越面板至上方');
        assert(alerts.length === 0, alerts.join(','));
        document.getElementById('telegramDriveBtn').onclick = () => window.DiskUI.open();
        await post('/control-report', { status: 'PASS', results });
    } catch (error) { await post('/control-report', { status: 'FAIL', error: error.stack, results, alerts }); }
}
