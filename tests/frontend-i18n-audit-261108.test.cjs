'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{scan}=require('../tools/frontend-i18n-audit');
test('UI audit preserves protocol fields and calls while native dialogs use the shared frontend interface',()=>{
 const source="socket.emit('中文协议事件',{action:'中文字段值'}); const title='技术对接'; alert('用户提示'); document.getElementById('label').textContent='界面文案';";
 const result=scan(source,{rewrite:true});assert.equal(result.rewritten,1);assert.ok(result.phrases.includes('用户提示'));assert.ok(result.phrases.includes('界面文案'));assert.equal(result.phrases.includes('中文协议事件'),false);assert.equal(result.phrases.includes('中文字段值'),false);assert.match(result.source,/socket\.emit\('中文协议事件',\{action:'中文字段值'\}\)/);
});
test('local functions, parameters, destructuring and hoisted declarations are not rewritten as native dialogs',()=>{
 const source="confirm('系统提示'); { const confirm=x=>x; confirm('程序调用'); } function f({alert},prompt){alert('程序信息');prompt('接口参数')} function g(){confirm('本地调用'); function confirm(value){return value}}";
 const result=scan(source,{rewrite:true});assert.equal(result.rewritten,1);assert.match(result.source,/\(window\.TunnelI18n\?\.confirm \|\| confirm\)\('系统提示'\)/);assert.equal(result.phrases.includes('程序调用'),false);assert.match(result.source,/alert\('程序信息'\);prompt\('接口参数'\)/);
});

test('native window methods and a proven window alias migrate, but another API object and shadowed windows do not',()=>{
 const source="window.confirm('系统确认');(function(global){global.alert('浏览器提示')})(window);function other(window){window.confirm('接口调用')}const api={confirm(){}};api.confirm('程序参数');(function(global){global.prompt('其它接口')})(api);";
 const result=scan(source,{rewrite:true});assert.equal(result.rewritten,2);assert.match(result.source,/TunnelI18n\?\.confirm \|\| window\.confirm/);assert.match(result.source,/TunnelI18n\?\.alert \|\| global\.alert/);assert.match(result.source,/window\.confirm\('接口调用'\)/);assert.match(result.source,/api\.confirm\('程序参数'\)/);assert.equal(result.phrases.includes('其它接口'),false);
 assert.equal(scan(result.source,{rewrite:true}).rewritten,0,'rewriting is idempotent');
});

test('UI status-map values, conditional captions and element text are audited without treating keys or technical code as labels',()=>{
 const result=scan("const label=t(({playing:'正在播放',stopped:'已停止'})[status]||status);button(enabled?'启用':'停用');text('p','用户说明');text('pre','技术栈信息');node.textContent=done?'已完成':'进行中';socket.emit('传输事件',{status:'协议值'});");
 for(const text of ['正在播放','已停止','启用','停用','用户说明','已完成','进行中'])assert.ok(result.phrases.includes(text),text);
 for(const text of ['playing','技术栈信息','传输事件','协议值'])assert.equal(result.phrases.includes(text),false,text);
});

test('only explicitly identified human error-message dictionaries are audited; their technical keys remain unchanged',()=>{
 const source="const codes={API_ERROR:'界面错误说明'};const wire={STATE:'程序协议字段'};Object.assign(codes,{LATE_ERROR:'稍后新增的说明'});codes.FINAL_ERROR='最终说明';";
 assert.deepEqual(scan(source).phrases,[]);
 const result=scan(source,{uiMaps:['codes'],rewrite:true});
 assert.deepEqual(result.phrases,['界面错误说明','稍后新增的说明','最终说明']);assert.equal(result.source,source);assert.equal(result.rewritten,0);
});
