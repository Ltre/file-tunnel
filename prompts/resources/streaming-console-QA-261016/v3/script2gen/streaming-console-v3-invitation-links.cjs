// 仅给既有 v3 浏览页及其模板补充入口；不重生成原有 SVG、PNG 或移动页面。
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const before = '<a href="mobile/index.html" target="_blank">独立移动预览</a></header>';
const after = '<a href="mobile/index.html" target="_blank">独立移动预览</a><a id="invitation-flow-link" href="42-invitation-flow.html#devices">邀请与 Markdown 补充</a></header>';
for (const file of [path.join(root, 'index.html'), path.join(__dirname, 'streaming-console-v3-gallery.cjs')]) {
  const source = fs.readFileSync(file, 'utf8');
  if (source.includes('id="invitation-flow-link"')) continue;
  if (!source.includes(before)) throw new Error('未找到 v3 顶部原型导航：' + file);
  fs.writeFileSync(file, source.replace(before, after));
  console.log('Added invitation prototype entry:', path.relative(root, file));
}
