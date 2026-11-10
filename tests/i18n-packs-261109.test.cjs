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
