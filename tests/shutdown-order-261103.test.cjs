'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const server=fs.readFileSync(require.resolve('../server.js'),'utf8');
function fixture(platform){
    const handlers={},events=[],childHandlers={},child={pid:2,kill:signal=>events.push('kill:'+signal),on:(event,fn)=>{childHandlers[event]=fn;}};
    const process={platform,env:{DR2T_PROXY:'http://fixture'},execPath:'node',execArgv:[],argv:['node','server.js'],on:(event,fn)=>{handlers[event]=fn;},exit:code=>events.push('exit:'+code)};
    const runtime=vm.createContext({process,processDiagnostics:{setPhase(){},markShutdown:signal=>events.push('shutdown:'+signal),proxyChildExit:()=>events.push('child-exit'),proxyChildError(){}},resolveTelegramProxyUrl:()=>process.env.DR2T_PROXY,console:{log(){}},setInterval(){},require:name=>{assert.equal(name,'child_process');return{spawn:()=>child};}});
    const source=server.slice(server.indexOf('if (!process.env.NODE_USE_ENV_PROXY'),server.indexOf("const express = require('express')"));
    vm.runInContext('(function(){'+source+'})()',runtime);return{handlers,events,childHandlers};
}
test('Windows console Ctrl+C waits for the already signalled child instead of forcibly killing it twice',()=>{
    const f=fixture('win32');f.handlers.SIGINT();assert.deepEqual(f.events,['shutdown:SIGINT']);
    f.childHandlers.exit(0,null);assert.deepEqual(f.events,['shutdown:SIGINT','child-exit','exit:0']);
});
test('non-Windows and explicit termination still forward the shutdown signal',()=>{
    const f=fixture('linux');f.handlers.SIGINT();assert.deepEqual(f.events,['shutdown:SIGINT','kill:SIGINT']);
    const w=fixture('win32');w.handlers.SIGTERM();assert.deepEqual(w.events,['shutdown:SIGTERM','kill:SIGTERM']);
});
test('Ctrl+C diagnostics persist all three lifecycle records without interrupting the CMD prompt',t=>{
    const os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'quiet-shutdown-261103-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const script='const d=require('+JSON.stringify(require.resolve('../server/process-diagnostics'))+').installProcessDiagnostics();d.markShutdown("SIGINT");d.proxyChildExit({pid:123},0,null);process.exit(0);';
    const result=spawnSync(process.execPath,['-e',script],{encoding:'utf8',env:{...process.env,TUNNEL_DATA_DIR:dir},timeout:5000});
    assert.equal(result.status,0);assert.equal(result.stdout+result.stderr,'');
    const log=fs.readFileSync(path.join(dir,'server-process.log'),'utf8');
    assert.match(log,/\[server-shutdown\]/);assert.match(log,/\[server-proxy-exit\]/);assert.match(log,/\[server-exit\]/);
});
