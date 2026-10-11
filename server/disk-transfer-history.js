'use strict';
const crypto = require('node:crypto');

function namespaceName(namespace) {
    const name=namespace?.name ?? namespace?.displayName;
    if (typeof name === 'string' && name.trim() && !['undefined','null'].includes(name.trim())) return name;
    return namespace?.kind === 'collaboration' ? '协同项目（历史名称未记录）' : '网盘分区（历史名称未记录）';
}
function normalizedDetails(details) {
    return { ...details, source:{...details.source,name:namespaceName(details.source)}, target:{...details.target,name:namespaceName(details.target)} };
}
function originOf(details, fallbackScope) {
    return details.source.kind === 'collaboration'
        ? { kind:'collaboration',collaborationId:details.source.id }
        : { kind:'native',partitionId:details.source.id,diskSpace:details.source.diskSpace ?? fallbackScope.diskSpace ?? '' };
}

// Observe browser transfers without changing the underlying mutation/recovery protocol.
function transferHistory({ operations, describe }) {
    return (req, res, next) => {
        const local = req.path.replace(/^\/(?:mount-scope|collaboration-scope)\/[^/]+/, '');
        const transfer = req.method === 'POST' && ['/cross-scope/copy','/cross-scope/move','/spaces/transfer'].includes(local)
            || req.method === 'PATCH' && (local === '/directories' && req.body?.destinationPath !== undefined
                || /^\/files\/[^/]+$/.test(local) && req.body?.folderPath !== undefined);
        if (!transfer) return next();
        const actorScope = { ...req.diskScope };
        const requestId = String(req.body?.requestId || '');
        if (requestId && !/^[-\w]{8,100}$/.test(requestId)) return next(new Error('DISK_SELECTION_INVALID'));
        const signature = crypto.createHash('sha256').update(JSON.stringify([req.method,req.path,req.body])).digest('hex');
        // A cross-scope request can be issued from a different current view.
        // Locate the actor's original record before inspecting a source which
        // may already have moved or disappeared after the successful request.
        const previous = requestId && operations.findHistoryForActor(actorScope.userId, requestId);
        if (previous && previous.requestSignature !== signature) return next(new Error('CONTENT_WRITE_CONFLICT'));
        if (previous && ['queued','running'].includes(previous.status)) return next(new Error('OPERATION_IN_PROGRESS'));
        if (previous?.errorCode === 'TRANSFER_RESULT_UNCONFIRMED') return next(new Error('CONTENT_WRITE_CONFLICT'));
        if (previous?.response && previous.phase !== 'source-retained') return res.status(previous.responseStatus || 200).json(previous.response);
        let details;
        try { details = describe(req, local); } catch (_) { return next(); } // Original route remains the authority for errors.
        details=normalizedDetails(previous?.transferDetails || details);
        const origin=originOf(details,previous || actorScope);
        const scope=origin.kind==='native'?{...actorScope,diskSpace:origin.diskSpace}:actorScope;
        const job = previous || operations.create(scope, 'transfer-history', details.mode === 'move' ? '移动明细' : '复制明细');
        if (previous) operations.reopenHistory(job.operation_id);
        operations.update(job.operation_id, { transferDetails:details,historyOrigin:origin,historyActorId:actorScope.userId,requestId,requestSignature:signature,phase:'starting',message:'正在执行',percent:null }, true);
        const send = res.json.bind(res);
        res.json = data => {
            try {
            if (res.statusCode >= 400 || data?.error) {
                operations.fail(job.operation_id, Object.assign(new Error(data?.error || 'DISK_OPERATION_FAILED'), { userMessage:data?.userMessage, errorDetails:data?.errorDetails }));
            } else if (data?.operation_id) {
                operations.update(job.operation_id, {responseStatus:res.statusCode,response:data},true);
                const source = operations.get(data.operation_id, req.diskScope);
                if (source) {
                    operations.annotateTransfer(source.operation_id, { historyMirrorId:job.operation_id,historyActorId:scope.userId,historyOrigin:origin,
                        ...(source.userId===scope.userId?{transferDetails:details}:{}) });
                    if (['completed','failed','cancelled'].includes(source.status)) operations.mirrorHistory({...source, historyMirrorId:job.operation_id});
                    else operations.update(job.operation_id, { status:'running', phase:source.phase, message:'正在执行' }, true);
                }
            } else {
                const partial = data?.state === 'COPIED_SOURCE_RETAINED';
                operations.update(job.operation_id, { responseStatus:res.statusCode, response:data }, true);
                if (partial) operations.update(job.operation_id, { status:'failed', phase:'source-retained', percent:null,
                    message:'已复制，来源仍保留', result:data, errorCode:data.warning?.code || 'SOURCE_RETAINED', errorMessage:data.warning?.userMessage || '目标已保留，删除来源尚未完成，可安全重试' }, true);
                else operations.complete(job.operation_id, data);
            }
            } catch(error) {
                console.warn('[disk-history] detail persistence failed', {operationId:job.operation_id,code:error.code||'HISTORY_WRITE_FAILED'});
                // Never turn an already committed mutation into an apparent failure.
                if(res.statusCode<400)data={...data,historyWarning:'操作已执行，但任务明细未能保存；请核对目标位置，不要直接重复操作'};
            }
            return send(data);
        };
        next();
    };
}
module.exports = { transferHistory, namespaceName };
