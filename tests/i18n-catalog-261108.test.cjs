'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
test('catalog translations preserve their source placeholders and never silently embed untranslated Chinese parameters in other scripts',()=>{
    const context={window:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../client/i18n-catalog.js'),'utf8'),context);
    const tokens=text=>[...new Set(text.match(/\{(?:\d+|n|raw\d+)\}/g)||[])].sort().join(',');
    const errors=[];for(const [source,translations]of Object.entries(context.window.Drop2TunnelI18nCatalog))for(const[language,value]of Object.entries(translations)){
        if(tokens(source)!==tokens(value))errors.push({source,language,reason:'placeholder mismatch'});
        if(!['zh-Hans','zh-Hant','ja'].includes(language)&&/\p{Script=Han}/u.test(value))errors.push({source,language,reason:'untranslated Chinese text'});
    }
    assert.deepEqual(errors,[]);
});
