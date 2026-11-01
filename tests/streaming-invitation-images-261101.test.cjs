'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createStreamingConsole}=require('../server/streaming-console');
const {createStreamingTunnels}=require('../server/streaming-tunnels');
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVioAAAAASUVORK5CYII=';
function fixture(t){
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'stream-invitation-images-261101-')),actor={deviceId:'source-device',userId:null,logins:[]};
 t.after(()=>{assert.equal(path.dirname(dataDir),path.resolve(os.tmpdir()));fs.rmSync(dataDir,{recursive:true,force:true});});
 const service=createStreamingConsole({dataDir}),station=service.register(actor.deviceId,'s'.repeat(40),'Source')&&service.create(actor,{name:'Invitation',creationId:'invitation-image-create'});
 const records=[],current={devices:new Map()};
 const tunnel=createStreamingTunnels({session:()=>current,messages:()=>records,admitted:(_s,device,grant)=>device===actor.deviceId&&grant==='proof',capability:()=>true,publish:(_s,_c,message)=>records.push(message)});tunnel.bind(service);
 return{dataDir,actor,service,station,records,tunnel};
}
test('invitation poster is a bounded persistent snapshot, omitted from repeated list payloads',t=>{
 const f=fixture(t),invite=f.service.invitation(f.station.id,f.actor,{poster:image,requestId:'poster-snapshot'});
 assert.equal(invite.poster,image);assert.equal(f.service.inspectInvite(invite.token,f.actor).poster,image);
 assert.equal(f.service.invitation(f.station.id,f.actor,{poster:null,requestId:'poster-snapshot'}).poster,image,'a retry retains the original poster');
 assert.equal('poster' in f.service.invitations(f.station.id,f.actor)[0],false,'management list does not repeatedly carry poster bytes');
 const reloaded=createStreamingConsole({dataDir:f.dataDir});assert.equal(reloaded.inspectInvite(invite.token,f.actor).poster,image);
 for(const poster of ['https://example.invalid/private.png','data:image/svg+xml;base64,PHN2Zz4=','data:image/png;base64,'+'A'.repeat(150000)])assert.equal(f.service.invitation(f.station.id,f.actor,{poster}).poster,null);
});
test('tunnel invitation Markdown contains the saved poster and keeps authority and idempotence checks',t=>{
 const f=fixture(t),invite=f.service.invitation(f.station.id,f.actor,{poster:image}),input={sessionId:'joined-tunnel',accessGrant:'proof',inviteToken:invite.token,messageId:'poster-tunnel-message'};
 const sent=f.tunnel.send(input,f.actor);assert.equal('poster' in sent.message,false,'the message does not duplicate its embedded poster bytes');assert.ok(sent.message.markdown.includes(']('+image+')'));
 assert.match(sent.message.markdown,/\[!\[串流台邀请海报\]/);assert.ok(sent.message.markdown.includes('/?stream_invite='+invite.token));
 assert.equal(f.tunnel.send(input,f.actor).duplicate,true);assert.equal(f.records.length,1);
 assert.throws(()=>f.tunnel.send({...input,messageId:'other-message',accessGrant:'wrong'},f.actor),/STREAM_TUNNEL_DENIED/);
 f.service.revoke(f.station.id,f.actor,invite.id);assert.throws(()=>f.tunnel.send({...input,messageId:'revoked-message'},f.actor),/STREAM_INVITE_(REVOKED|INVALID)/);assert.equal(f.records.length,1);
});
test('a pre-poster invitation still embeds its captured thumbnail when forwarded',t=>{
 const f=fixture(t),invite=f.service.invitation(f.station.id,f.actor,{thumbnail:image});
 const result=f.tunnel.send({sessionId:'joined-tunnel',accessGrant:'proof',inviteToken:invite.token,messageId:'legacy-thumbnail-message'},f.actor);
 assert.equal(result.message.thumbnail,image);assert.ok(result.message.markdown.includes(']('+image+')'));assert.equal('poster' in result.message,false);
});
test('a retry of an already sent legacy invitation retains its old history record',t=>{
 const f=fixture(t),invite=f.service.invitation(f.station.id,f.actor,{thumbnail:image});
 const existing={id:'old-submission-id',sender:f.actor.deviceId,purpose:'stream-invitation',thumbnail:image,markdown:'串流邀请 · Invitation\n\n[打开邀请](/?stream_invite='+invite.token+')'};f.records.push(existing);
 const input={sessionId:'joined-tunnel',accessGrant:'proof',inviteToken:invite.token,messageId:existing.id};
 assert.equal(f.tunnel.send(input,f.actor).message,existing);assert.equal(f.records.length,1);
 existing.markdown+=' changed';assert.throws(()=>f.tunnel.send(input,f.actor),/STREAM_CONFLICT/);
});
