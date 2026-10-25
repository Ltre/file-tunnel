'use strict';
require('./pending-save-261012-fixture.cjs').createFixture({serverTransfers:true}).then(fixture=>{
    fixture.app.get('/fixture-ready/:id',(req,res)=>{fixture.sessions.set(req,res,fixture.auth.user(req.params.id));res.redirect('/sns-dl');});
    console.log(JSON.stringify({base:fixture.base,dataDir:fixture.dataDir}));
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>fixture.close().then(()=>process.exit()));
});
