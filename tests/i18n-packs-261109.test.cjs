'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
test('generated language packs remain exactly consistent with the single authored catalog, and startup omits other language payloads',()=>{
 const result=require('../tools/build-i18n-packs.cjs').generate({check:true});assert.ok(result.startupBytes<result.sourceBytes/5);
 const context={window:{}};vm.runInNewContext(fs.readFileSync(path.join(root,'client/i18n-bootstrap.js'),'utf8'),context);
 assert.deepEqual([...context.window.Drop2TunnelI18nConfig.loadedLanguages],['zh-Hans','zh-Hant','en']);
 for(const entry of Object.values(context.window.Drop2TunnelI18nCatalog))assert.deepEqual(Object.keys(entry).filter(key=>!['zh-Hans','zh-Hant','en'].includes(key)),[]);
 for(const file of fs.readdirSync(path.join(root,'pages')).filter(file=>file.endsWith('.html'))){const html=fs.readFileSync(path.join(root,'pages',file),'utf8');assert.equal(/src=["']\/client\/i18n-catalog\.js/.test(html),false,file);if(html.includes('/client/i18n-bootstrap.js'))assert.equal((html.match(/src=["']\/client\/i18n-bootstrap\.js/g)||[]).length,1,file+' loads the startup catalog once');}
 const authored={window:{}};vm.runInNewContext(fs.readFileSync(path.join(root,'client/i18n-catalog.js'),'utf8'),authored);
 for(const [language]of authored.window.Drop2TunnelI18nConfig.languages){
  if(['zh-Hans','en'].includes(language))continue;
  const pack=JSON.parse(fs.readFileSync(path.join(root,'client/i18n',language+'.json'),'utf8'));assert.equal(pack.language,language);assert.equal(pack.version,result.version);
  for(const [key,values]of Object.entries(authored.window.Drop2TunnelI18nCatalog))assert.equal(pack.catalog[key],values[language]||values.en||key,language+':'+key);
 }
});
test('German covers the full catalog and Persian is absent from source configuration and generated assets',()=>{
 const context={window:{}};vm.runInNewContext(fs.readFileSync(path.join(root,'client/i18n-catalog.js'),'utf8'),context);
 const config=context.window.Drop2TunnelI18nConfig,catalog=context.window.Drop2TunnelI18nCatalog;
 assert.ok(config.languages.some(([lang])=>lang==='de'));assert.ok(!config.languages.some(([lang])=>lang==='fa'));assert.ok(!config.dynamicLanguages.includes('fa'));
 assert.equal(fs.existsSync(path.join(root,'client/i18n/fa.json')),false);
 for(const[key,row]of Object.entries(catalog)){assert.equal(typeof row.de,'string',key);assert.ok(row.de.trim(),key);assert.equal(Object.hasOwn(row,'fa'),false,key);}
 for(const key of ['打开','管理协同编辑','新建文件.txt','暂无未使用的邀请链接','合辑文件 {0}','收藏时间'])for(const lang of config.dynamicLanguages)assert.ok(catalog[key][lang],key+': '+lang);
 const server=require('../server/i18n');assert.equal(server.normalizeLanguageCode('de-DE'),'de');assert.match(server.translateTelegramText('当前处于 A1B2C 隧道中转模式','de'),/A1B2C/);
});
