'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createWebZipCredentials}=require('../server/web-zip-credentials');
test('webpage credentials survive restart and are bound to device, creator, webpage, target and source permissions',t=>{
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'webzip-credential-'));t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));
 const scope={deviceId:'editor',creatorDeviceId:'creator',rootId:'page',sessionId:'B',messageId:'copy',sourceSessionId:'A',sourceMessageId:'original',permissionAt:1,sourcePermissionAt:2};
 const token=createWebZipCredentials({dataDir}).issue(scope),service=createWebZipCredentials({dataDir});assert.equal(service.verify(token,scope),true);
 for(const key of Object.keys(scope))assert.equal(service.verify(token,{...scope,[key]:'wrong'}),false,key);
 assert.equal(service.verify(token.slice(0,-3)+'bad',scope),false);assert.equal(service.verify(token.replace('we1.','j1.'),scope),false);
});
