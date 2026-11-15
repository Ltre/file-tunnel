'use strict';
const path = require('node:path');
function registerUpstreamExitRoutes(app, { exits, requireAuth, root }) {
    app.use('/pages/upstream-exits.html', requireAuth);
    app.get('/upstream-exits', requireAuth, (_req,res)=>res.sendFile(path.join(root,'pages/upstream-exits.html')));
    app.get('/api/upstream-exits', requireAuth, (_req,res)=>{res.setHeader('Cache-Control','no-store');res.json(exits.publicConfig());});
    const action = work => async (req,res)=>{
        res.setHeader('Cache-Control','no-store');
        try{res.json(await work(req));}catch(error){res.status(/不存在|修改/.test(error.message)?409:422).json({error:error.message});}
    };
    app.post('/api/upstream-exits/nodes',requireAuth,action(req=>exits.saveNode(null,req.body)));
    app.put('/api/upstream-exits/nodes/:id',requireAuth,action(req=>exits.saveNode(req.params.id,req.body)));
    app.delete('/api/upstream-exits/nodes/:id',requireAuth,action(req=>{exits.deleteNode(req.params.id);return{ok:true};}));
    app.put('/api/upstream-exits/services/:id',requireAuth,action(req=>exits.saveService(req.params.id,req.body)));
    app.post('/api/upstream-exits/test',requireAuth,action(req=>exits.testPage(req.body?.url,req.body?.exit)));
    app.post('/api/upstream-exits/confirm',requireAuth,action(req=>exits.confirmExit(req.body?.exit)));
    app.use(['/api/youtube-premium/formats','/api/sns-dl/formats'],requireAuth,exits.requestScope);
}
module.exports={registerUpstreamExitRoutes};
