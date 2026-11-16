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
    for(const [pattern,translations] of context.window.Drop2TunnelI18nConfig.templates){
        assert.equal(translations.length,context.window.Drop2TunnelI18nConfig.dynamicLanguages.length,'every dynamic rule supports every language: '+pattern);
    }
});

test('audited frontend UI and runtime drive error explanations have every supported target language',()=>{
    const report=require('../tools/frontend-i18n-audit').run();
    assert.deepEqual(report.filter(item=>item.missing.length),[],'audit candidates must resolve in all 15 target languages');
    const context={window:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../client/i18n-catalog.js'),'utf8'),context);
    const canonical=value=>value.replace(/\s/g,''),catalog=new Map(Object.entries(context.window.Drop2TunnelI18nCatalog).map(([key,value])=>[canonical(key),value]));
    const errors=require('../client/disk-error-messages'),missing=[];
    for(const text of new Set([...Object.values(errors.codes),...Object.values(errors.reasons),errors.describe('unknown')])){
        for(const language of context.window.Drop2TunnelI18nConfig.dynamicLanguages)if(!catalog.get(canonical(text))?.[language])missing.push({text,language});
    }
    assert.deepEqual(missing,[],'runtime codes, including final overrides, retain technical keys and have native UI explanations');
});
