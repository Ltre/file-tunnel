'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../client/disk-ui.js'), 'utf8');
const begin = source.indexOf('async function resumeTelegramDrivePendingSave(');
const resumeSource = source.slice(begin, source.indexOf('function telegramDriveErrorText(', begin));

function fixture({ allowSwitch = true, fresh = false, afterStart } = {}) {
    let account = fresh ? 'saved-account' : 'other-account';
    const record = { id:'pending-save-original', status:'completed', target:{accountId:'saved-account',accountName:'保存账号',partitionId:'original-partition-id',partitionName:'保存分区',diskSpace:'original-space',path:'原保存目录/子目录'},
        result:{items:[{id:'saved-file-a'},{id:'saved-file-b'}]},file:{name:'任务成品.mp4',size:123} };
    const baseline = structuredClone(record), calls = {switches:[],reveals:[],feedback:[],verified:0,banners:0,finished:0};
    const context = { telegramDrivePendingSaveId:record.id,telegramDrivePendingSaveRunning:false,telegramDriveNavigationVersion:7,
        document:{getElementById:()=>null},
        pendingSaveFeedback:(...args) => calls.feedback.push(args),finishPendingSaveFeedback:()=>{calls.finished++;},showAppToast:message=>calls.feedback.push(['toast',false,message]),
        pendingSaveRead:async route => { assert.equal(route,'/accounts'); return {accounts:[{identity:{id:'saved-account'}}]}; },
        choosePendingSaveTarget(){ throw Error('completed receipt must not choose another destination'); },
        pendingSaveTransferId:value => value.id,confirmTelegramDriveAction:async () => true,formatFileSize:String,telegramDriveDisplayPath:String,telegramDriveSpaceKey:value => value.diskSpace,
        showTelegramDrivePendingSaveBanner:async () => {calls.banners++;},telegramDriveErrorText:error => error.message,
        switchTelegramDriveAccount:async (id,options) => { calls.switches.push({id,options}); if (!allowSwitch) return false; account=id; context.telegramDriveNavigationVersion++; return true; },
        revealTelegramDriveUploadedDirectory:async (...args) => {calls.reveals.push(args);return true;}
    };
    context.window = {DiskClient:{getAccount:() => account},DiskPendingSave:{
        describeTarget:value => value.target.accountId+' · '+value.target.diskSpace+' · /'+value.target.path,
        inspectSaved:async value => {assert.equal(value,record);calls.verified++;return {state:'saved',files:value.result.items};},
        resume:async (id,hooks) => {
            assert.equal(id,record.id);
            if (fresh) { await hooks.onStarted(record); afterStart?.(context, id => {account=id;}); }
            else assert.equal((await hooks.verifySaved(record)).state,'saved');
            await hooks.onCompleted(record); return record;
        }
    }};
    const run = vm.runInNewContext(resumeSource+';resumeTelegramDrivePendingSave;',context);
    return {run,context,calls,record,baseline,getAccount:() => account};
}

test('declining the different-account guard retains the completed receipt without revealing or changing accounts', async () => {
    const f = fixture({allowSwitch:false}); await f.run();
    assert.equal(f.calls.verified,1); assert.equal(f.calls.switches.length,1);
    assert.equal(f.calls.switches[0].id,'saved-account'); assert.equal(f.calls.switches[0].options.deferContents,true);
    assert.equal(f.calls.reveals.length,0); assert.equal(f.getAccount(),'other-account');
    assert.deepEqual(f.record,f.baseline); assert.equal(f.context.telegramDrivePendingSaveRunning,false);
});

test('accepting location switches to the saved account and reveals original partition, path and exact file IDs', async () => {
    const f = fixture(); await f.run();
    assert.equal(f.calls.reveals.length,1);
    const [directory,navigationVersion,items,transport] = f.calls.reveals[0];
    assert.equal(directory,f.record.target.path); assert.equal(navigationVersion,8);
    assert.equal(items,f.record.result.items); assert.deepEqual(items.map(item => item.id),['saved-file-a','saved-file-b']);
    assert.equal(transport.accountId,'saved-account'); assert.equal(transport.diskSpace,'original-space'); assert.equal(transport.requestBase,'/api/telegram/drive');
    assert.equal(f.getAccount(),'saved-account'); assert.deepEqual(f.record,f.baseline);
    assert.ok(f.calls.feedback.some(args => String(args[2]).includes('original-space') && String(args[2]).includes(f.record.target.path)));
});

test('fresh transfer completion does not take over after the user navigates to another directory', async () => {
    const f = fixture({fresh:true,afterStart:context => {context.telegramDriveNavigationVersion++;}}); await f.run();
    assert.equal(f.calls.reveals.length,0); assert.equal(f.calls.switches.length,0);
    assert.deepEqual(f.record,f.baseline); assert.equal(f.record.status,'completed');
    assert.equal(f.calls.finished,1,'completed transfer progress ends without redirecting the newer view');
});

test('fresh transfer completion does not switch back after the user changes the selected account', async () => {
    const f = fixture({fresh:true,afterStart:(_context,setAccount) => setAccount('other-account')}); await f.run();
    assert.equal(f.calls.reveals.length,0); assert.equal(f.calls.switches.length,0); assert.equal(f.getAccount(),'other-account');
    assert.deepEqual(f.record,f.baseline);
    assert.equal(f.calls.finished,1,'completed transfer progress ends without switching accounts');
});

test('fresh completion still locates saved files when no user navigation occurred', async () => {
    const f = fixture({fresh:true}); await f.run();
    assert.equal(f.calls.reveals.length,1); assert.equal(f.calls.reveals[0][1],7);
    assert.equal(f.calls.switches.length,0); assert.equal(f.calls.reveals[0][2],f.record.result.items);
    assert.deepEqual(f.record,f.baseline);
});
