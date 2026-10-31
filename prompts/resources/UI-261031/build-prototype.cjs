// Assemble the prototype from the current branch's existing home markup/CSS.
// Only files in this directory are written.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const source = fs.readFileSync(path.join(root,'pages/index.html'),'utf8');
const begin = source.indexOf('    <header class="tunnel-topbar"');
const end = source.indexOf('    <!-- 传输进度 -->', begin);
const auxiliaryEnd = source.indexOf('    <div class="modal-overlay" id="telegramDriveOverlay"', end);
if ([begin,end,auxiliaryEnd].some(value => value < 0)) throw Error('找不到当前首页结构');
let home = source.slice(begin,end)
  .replace('id="tunnelTopbar" hidden','id="tunnelTopbar"')
  .replace('id="appShell" data-mobile-view="chat" hidden','id="appShell" data-mobile-view="chat"')
  .replaceAll('src="/client/icons/streaming.png"','src="streaming.png"');
const auxiliary = source.slice(end,auxiliaryEnd);
for (const [from,to] of [['client/index.css','base-index.css'],['client/themes.css','base-themes.css'],['client/themes-legacy.css','base-themes-legacy.css'],['client/notification-center.css','base-notification-center.css'],['client/icons/streaming.png','streaming.png']]) {
  fs.copyFileSync(path.join(root,from),path.join(__dirname,to));
}
const html = '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>隧道三栏 · blamen 主题原型</title><link rel="stylesheet" href="base-notification-center.css"><link rel="stylesheet" href="base-themes-legacy.css"><link rel="stylesheet" href="base-index.css"><link rel="stylesheet" href="base-themes.css"><link rel="stylesheet" href="tunnel-prototype.css"><script src="tunnel-prototype.js" defer></script></head><body data-theme="lumen" data-prototype-skin="reference">\n' + home + auxiliary + '\n</body></html>';
fs.writeFileSync(path.join(__dirname,'tunnel-prototype.html'),html);
const referenceImage = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(__dirname,'index.jpg')).toString('base64');
for (const [name,viewBox] of [
  ['sample-document-a.svg','465 132 160 125'],
  ['sample-document-b.svg','625 132 195 125'],
  ['sample-document-c.svg','465 257 160 137'],
  ['sample-document-d.svg','625 257 195 137'],
  ['sample-photo.svg','445 618 226 204']
]) {
  fs.writeFileSync(path.join(__dirname,name),'<svg xmlns="http://www.w3.org/2000/svg" viewBox="'+viewBox+'"><image href="'+referenceImage+'" width="1538" height="1023"/></svg>');
}
console.log('已复制当前首页结构和样式到原型目录。');
