'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const server=fs.readFileSync(require('node:path').join(__dirname,'../server.js'),'utf8');
const section=(a,b)=>server.slice(server.indexOf(a),server.indexOf(b,server.indexOf(a)));
test('new messages are stored, acknowledged and broadcast without referring to a previous record',()=>{
    for(const type of ['text','file','collection','markdown']){
        let receive;const stored=[],sent=[],errors=[],broadcast=[];
        const session={devices:new Map([['sender',{}]])};
        vm.runInNewContext(section("    socket.on('message',", "    socket.on('forward-message',"),{
            socket:{id:'socket',on:(_event,run)=>receive=run,emit:(...args)=>sent.push(args)},currentSession:'tunnel',currentDevice:'sender',clientIp:'127.0.0.1',
            sessions:new Map([['tunnel',session]]),Date,console:{error:(...args)=>errors.push(args.map(String).join(' '))},
            checkMessageRate:()=>true,isValidSessionId:()=>true,tunnelMessageCapabilities:()=>['sendText'],canUseTunnelCapability:()=>true,
            getMessageSnsText:()=>'',createSnsPlaceholderMetadata:()=>({sources:[]}),MAX_MESSAGE_SIZE:1048576,
            addToSessionHistory:(_id,_session,message)=>{stored.push(message);return {stored:true};},historyLog(){},summarizeHistoryMessage:x=>x.id,
            emitToReadableSessionDevices:(_session,event,value)=>broadcast.push({event,value}),scheduleSessionHistoryBroadcast(){},queueSnsMetadataScan(){},emitSocketError(){throw Error('unexpected socket error');}
        });
        receive({sessionId:'tunnel',message:{id:'new-'+type,type,sender:'sender',text:'New text'}});
        assert.deepEqual(errors,[],type);assert.equal(stored.length,1,type);assert.equal(sent[0][0],'message-ack');assert.equal(sent[0][1].stored,true);
        assert.equal(broadcast[0].event,'message');
    }
});
test('legacy updates cannot overwrite edited text or its version while favorites still update',()=>{
    let receive;const emitted=[],errors=[];
    const saved={id:'existing',type:'text',text:'Edited text',textVersion:3,textEditedAt:42,textEditorDeviceId:'editor'};
    const session={devices:new Map([['sender',{}]]),history:[{message:saved,size:100}],historySize:100};
    vm.runInNewContext(section("    socket.on('update-message',", "    socket.on('sns-post-markdown',"),{
        socket:{id:'socket',on:(_event,run)=>receive=run,emit(){}},currentSession:'tunnel',currentDevice:'sender',clientIp:'127.0.0.1',
        sessions:new Map([['tunnel',session]]),Date,Buffer,MAX_HISTORY_SIZE:10000,isValidDeviceId:()=>true,
        createHistoryMessage:x=>({...x}),preserveNewestTelegramFileIds:(_old,next)=>next,persistHistoryAudit(){},
        emitToReadableSessionDevices:(_session,_name,value)=>emitted.push(value.message),scheduleSessionHistoryBroadcast(){},historyLog(){},summarizeHistoryMessage:x=>x.id,
        console:{error:(...args)=>errors.push(args.map(String).join(' '))}
    });
    receive({sessionId:'tunnel',message:{...saved,text:'Stale text',textVersion:1}});assert.equal(emitted.length,0);assert.equal(session.history[0].message,saved);
    receive({sessionId:'tunnel',message:{id:saved.id,type:'text',text:saved.text,favorite:true,textVersion:1}});
    assert.equal(emitted.length,1);assert.equal(emitted[0].textVersion,3);assert.equal(emitted[0].textEditedAt,42);assert.equal(emitted[0].textEditorDeviceId,'editor');assert.equal(emitted[0].favorite,true);assert.deepEqual(errors,[]);
});
