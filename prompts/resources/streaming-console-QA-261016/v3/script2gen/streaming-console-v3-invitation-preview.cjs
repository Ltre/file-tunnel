// 只打开本地补充原型，回放演示并生成审核图片；不运行应用或访问正式接口。
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('C:/Users/Dell/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const url = pathToFileURL(path.join(root, '42-invitation-flow.html')).href;
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const titles = { devices: '邀请可见设备', notifications: '通知中心', tunnel: '转发串流邀请到隧道', message: '隧道中的串流邀请', markdown: '普通 Markdown 消息示例' };
  async function review(view) {
    await page.locator('.nav a[href="#' + view + '"]').click();
    await page.locator('#main > h2').filter({ hasText: new RegExp('^' + titles[view] + '$') }).waitFor();
  }
  try {
    const html = fs.readFileSync(path.join(root, '42-invitation-flow.html'), 'utf8');
    new (require('node:vm').Script)(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
    await page.goto(url);
    await page.locator('[data-start="direct"]').click();
    await page.locator('[data-action="send"]').click();
    console.log('发送结果面板：', await page.locator('#feedback').evaluate(el => ({ text: el.innerText, background: getComputedStyle(el).backgroundColor, width: el.clientWidth, height: el.clientHeight })));
    await page.screenshot({ path: path.join(root, '42-invitation-devices.png'), fullPage: true });
    await review('notifications');
    console.log('本机通知中心：', await page.locator('#main').evaluate(el => ({ deviceSelectors: el.querySelectorAll('select').length, text: el.innerText })));
    await page.screenshot({ path: path.join(root, '43-invitation-notification.png'), fullPage: true });
    await page.locator('[data-open]').click();
    await page.locator('[data-accept]').click();
    console.log('接受邀请后：', await page.locator('.notification').innerText());
    await page.locator('[data-start="decline"]').click();
    await page.locator('[data-action="send"]').click();
    await review('notifications');
    await page.locator('[data-reject]').click();
    console.log('拒绝邀请后：', await page.locator('.notification').innerText());
    await review('devices');
    await page.locator('[data-device="B"]').uncheck();
    await page.locator('[data-device="C"]').check();
    await page.locator('[data-action="send"]').click();
    await review('notifications');
    console.log('发给其它设备的邀请不出现在本机：', await page.locator('#main').innerText());
    await page.locator('[data-start="tunnel"]').click();
    console.log('邀请消息正文（不带资源）：', await page.locator('#markdown-editor').inputValue());
    await page.locator('[data-action="forward"]').click();
    await page.screenshot({ path: path.join(root, '44-invitation-tunnel.png'), fullPage: true });
    console.log('发送后仍在创建者界面：', page.url());
    await review('message');
    console.log('邀请消息：', await page.locator('.message').evaluate(el => ({ thumbnails: el.querySelectorAll('.invite-thumbnail').length, exportButtons: el.querySelectorAll('[data-export]').length, text: el.innerText })));
    await page.locator('#markdown-body [data-action="tunnel-invite"]').click();
    console.log('隧道邀请可直接接受：', await page.locator('.modal-card').innerText());
    await page.locator('[data-action="join-tunnel"]').click();
    console.log('通过隧道邀请加入：', await page.locator('.modal-card').innerText());
    await page.locator('[data-action="close"]').click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(root, '45-markdown-message-mobile.png'), fullPage: true });
    await review('markdown');
    console.log('普通 Markdown 操作按钮：', await page.locator('.message [data-export]').allTextContents());
    await page.screenshot({ path: path.join(root, '46-markdown-resource-example.png'), fullPage: true });
    await page.locator('.expand').click();
    console.log('展开 Markdown：', await page.locator('#markdown-body').evaluate(el => ({ folded: el.classList.contains('folded'), height: el.clientHeight })));
    await page.locator('[data-export="download"]').click();
    console.log('普通消息 ZIP 仅含其自行引用的资源：', await page.locator('.file-tree').innerText());
    await page.locator('[data-action="close"]').click();
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const view of ['devices', 'notifications', 'tunnel', 'message', 'markdown']) {
        await review(view);
        console.log('视口检查：', await page.evaluate(() => ({ width: innerWidth, page: location.hash, contentWidth: document.documentElement.scrollWidth })));
      }
    }
    await review('tunnel');
    await page.locator('#markdown-editor').fill('这是一条不足十行的简短消息。');
    await page.locator('[data-action="forward"]').click();
    await review('message');
    console.log('短消息不折叠：', await page.locator('#markdown-body').evaluate(el => ({ folded: el.classList.contains('folded'), overlayHidden: el.querySelector('.blur-tail').hidden })));
    await review('tunnel');
    await page.locator('[data-thumbnail]').uncheck();
    await page.locator('[data-action="forward"]').click();
    await review('message');
    console.log('取消附带缩略图后：', await page.locator('.message').evaluate(el => ({ thumbnails: el.querySelectorAll('.invite-thumbnail').length, exportButtons: el.querySelectorAll('[data-export]').length })));
    await page.goto(pathToFileURL(path.join(root, 'mobile/index.html')).href + '#03-create-edit');
    await page.locator('input[data-form="visibility"][value="仅限邀请"]').check();
    await page.locator('[data-act="save-form"]').click();
    console.log('仅邀请台创建后的入口：', await page.locator('[data-act="invite-flow"]').allTextContents());
    await page.locator('[data-act="invite-flow"][data-value="devices"]').click();
    console.log('移动原型邀请入口：', page.url());
    console.log('浏览器脚本错误：', JSON.stringify(errors));
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
