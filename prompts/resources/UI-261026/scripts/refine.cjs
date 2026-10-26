const fs=require('node:fs'),path=require('node:path');
const base=path.resolve(__dirname,'..');
const update=(name,fn)=>{const p=path.resolve(base,name);if(!p.startsWith(base+path.sep))throw Error('SCOPE');fs.writeFileSync(p,fn(fs.readFileSync(p,'utf8')));};
const old='document.documentElement.dataset.skin=new URLSearchParams(location.search).get("variant")||"lumen";';
const replacement='const skin=new URLSearchParams(location.search).get("variant")||"lumen";if(skin==="source")delete document.documentElement.dataset.skin;else document.documentElement.dataset.skin=skin;';
update('scripts/capture.cjs',s=>s.replace(old,replacement).replace(" await page.goto(f.base+'/design-seed-login');await fullHome();", " if(!process.env.DESIGN_REMAINDER){\n await page.goto(f.base+'/design-seed-login');await fullHome();").replace(" await resetDisk();await page.locator('.telegram-drive-item-check').nth(0).check();await page.locator('.telegram-drive-item-check').nth(1).check();await take('disk-selection','网盘 · 批量选择');", " }\n await shotSource('disk','disk');await page.locator('.telegram-drive-item-check').first().evaluate(el=>el.click());await take('disk-selection','网盘 · 批量选择');").replace(" // Screen docs are frozen actual DOM;", " if(process.env.DESIGN_CAPTURE_ONLY)return;\n // Screen docs are frozen actual DOM;"));
for(const f of fs.readdirSync(path.join(base,'snapshots')).filter(n=>n.endsWith('.html')))update('snapshots/'+f,s=>s.replace(old,replacement));
update('scripts/build-gallery.cjs',s=>s.replace('w=2240,h=1680','w=2240,h=1960').replace('left:x,top:930','left:x,top:1130'));
console.log('Source comparison and review board corrected.');
