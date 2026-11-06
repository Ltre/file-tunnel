'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createStreamingTunnels}=require('../server/streaming-tunnels');
test('source location obtains a durable short code when the runtime session only has its remark',()=>{
    const tunnels=createStreamingTunnels({session:()=>({remark:'来源备注'}),shortCode:id=>id==='source'?'ABCDE':'',messages:()=>[]});
    const result=tunnels.describe({sessionId:'source',messageId:'anchor',fileId:'file'});
    assert.equal(result.shortCode,'ABCDE');assert.equal(result.remark,'来源备注');
});
