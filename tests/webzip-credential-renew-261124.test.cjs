'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createWebZipSync}=require('../server/web-zip-sync');
const {createWebZipCollaborationCredential}=require('../server/web-zip-collaboration-credentials');
test('旧原网页仍有当前编辑授权时，旧缓存凭据不能阻止重签；没有当前授权仍拒绝',t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'webzip-renew-261124-'));t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('webzip-renew-261124-'));fs.rmSync(dir,{recursive:true,force:true});});
    const credentials=createWebZipCollaborationCredential({dataDir:dir});
    const record={id:'original-record',type:'file',fileInfo:{id:'current-file',name:'legacy.html.zip',webZip:true,creatorDeviceId:'creator',webZipRootId:'old-root',webZipEditors:['editor'],webZipPermissionUpdatedAt:100}};
    const service=createWebZipSync({filename:path.join(dir,'jobs.json'),credentials,readRecord:()=>record,canPublish:()=>true,canSync:()=>false,writeRecord(){}});
    const stale=credentials.issue({deviceId:'editor',creatorDeviceId:'creator',rootId:'former-root',sessionId:'tunnel',messageId:record.id,sourceSessionId:'tunnel',sourceMessageId:record.id,permissionAt:0});
    const result=service.issueCredential({sessionId:'tunnel',messageId:record.id,fileId:'current-file',deviceId:'editor',editCredential:stale});
    assert.ok(credentials.verify(result,{deviceId:'editor',creatorDeviceId:'creator',rootId:'old-root',sessionId:'tunnel',messageId:record.id,sourceSessionId:'tunnel',sourceMessageId:record.id,permissionAt:100}));
    record.fileInfo.webZipEditors=[];assert.throws(()=>service.issueCredential({sessionId:'tunnel',messageId:record.id,fileId:'current-file',deviceId:'editor',editCredential:result}),error=>error.message==='WEB_ZIP_EDIT_DENIED'&&error.reason==='NOT_IN_EDITOR_LIST'&&error.requiresApproval===true);
});
