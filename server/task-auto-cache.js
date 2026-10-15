'use strict';
function createTaskAutoCache(){const active=new Map();
    function admit(key,req,res,task){if(req.get('X-Task-Auto-Cache')!=='1')return true;if(task?.autoCacheEnabled===false){res.status(409).json({error:'AUTO_CACHE_STOPPED'});return false;}let set=active.get(key);if(!set)active.set(key,set=new Set());set.add(res);res.once('close',()=>{set.delete(res);if(!set.size)active.delete(key);});return true;}
    function stop(key){for(const res of active.get(key)||[])res.destroy();active.delete(key);}
    return {admit,stop};
}
module.exports={createTaskAutoCache};
