'use strict';
const { diskErrorCode, diskErrorDetails } = require('./disk-errors');

// Each producer owns its disk writer. Telegram consumes an independent reader;
// this runner only limits outstanding requests, never pipes the incoming PUT.
function createProgressiveUploadRunner({ telegram, operations, chunkFileCache, log, wake, wait, commit, rollback }) {
    return async function run(req, store, job, update, control) {
        const total = job.files.reduce((sum, file) => sum + file.size, 0);
        const active = new Map(), sentByPart = new Map();
        let previousBytes = 0, previousTime = Date.now(), speed = 0;
        job.pipelineAbort = new AbortController();
        const signal = job.pipelineAbort.signal;
        operations.onCancel(job.operationId, () => { job.pipelineAbort.abort(); wake(job); });
        const key = (fileIndex, chunk) => `${fileIndex}:${chunk.partIndex}`;
        const publish = (patch = {}) => {
            let sent = 0, confirmed = 0;
            for (let i = 0; i < job.files.length; i++) for (const chunk of job.files[i].chunks) {
                if (chunk.tempRemote || chunk.remote) { confirmed += chunk.size; sent += chunk.size; }
                else sent += Math.min(chunk.size, sentByPart.get(key(i, chunk)) || 0);
            }
            const now = Date.now(), elapsed = (now - previousTime) / 1000;
            if (elapsed >= .2) {
                const measured = Math.max(0, sent - previousBytes) / elapsed;
                speed = speed ? speed * .7 + measured * .3 : measured;
                previousBytes = sent; previousTime = now;
            }
            const queue = store.uploadQueue(job.id);
            update({ telegramBytesSent: sent, telegramBytesConfirmed: confirmed, telegramTotalBytes: total,
                telegramBytesPerSecond: Math.round(speed), processedBytes: sent, totalBytes: total,
                percent: total ? Math.min(99, sent / total * 100) : null,
                ...(queue ? { clientPartsReceived: queue.receivedParts, clientPartsTotal: queue.totalParts,
                    telegramPartsUploaded: queue.uploadedParts, queueParts: queue.pendingParts, queueBytes: queue.pendingBytes } : {}), ...patch });
        };
        const assertRunning = () => {
            control.throwIfCancelled();
            if (job.pipelineFailure) throw job.pipelineFailure;
            if (signal.aborted) throw new Error('OPERATION_CANCELLED');
        };
        const physicalPart = (file, fileIndex, chunk) => {
            const count = file.parts.length, width = Math.max(2, String(count).length);
            const suffix = `.part${String(chunk.partIndex).padStart(width, '0')}-of-${String(count).padStart(width, '0')}`;
            return { fileIndex, logicalFileId: file.logicalId, partIndex: chunk.partIndex, partCount: count,
                originalSize: file.size, offset: chunk.offset, start: 0, size: chunk.size, path: chunk.path,
                type: count === 1 ? file.type : 'application/octet-stream', sha256: chunk.sha256 || '',
                name: count === 1 ? file.name : file.name.slice(0, Math.max(1, 180 - suffix.length)) + suffix,
                streamFactory: chunk.streamFactory, awaitSourceComplete: chunk.awaitSourceComplete };
        };
        const push = async (file, fileIndex, chunk) => {
            const part = physicalPart(file, fileIndex, chunk), id = key(fileIndex, chunk);
            const current = { telegramFileIndex: fileIndex + 1, telegramFileCount: job.files.length, telegramFileName: file.name,
                telegramPartIndex: chunk.partIndex, telegramPartCount: file.parts.length };
            if (chunk.sourceComplete && chunk.sha256) {
                try {
                    const cached = chunkFileCache.get(job.storage, part);
                    if (cached) part.reuseFileId = cached.fileId;
                } catch (error) { log('telegram.chunk-cache-write-failed', { uploadId: job.id, fileId: file.logicalId, action: 'get', error: diskErrorDetails(error) }); }
            }
            publish({ ...current, phase: 'telegram-queue', message: `正在推送：${file.name} · 分片 ${chunk.partIndex}/${file.parts.length}` });
            const remote = await telegram.pushChunk(job.storage, file, part, patch => {
                const bytes = Number.isFinite(patch.telegramPartBytesSent) ? patch.telegramPartBytesSent : (Number.isFinite(patch.telegramBytesSent) ? patch.telegramBytesSent : patch.bytes);
                if (Number.isFinite(bytes)) {
                    const pushed = Math.max(sentByPart.get(id) || 0, Math.min(chunk.size, bytes));
                    sentByPart.set(id, pushed);
                    // The disk writer/phase transition checkpoints these fields;
                    // progress events alone must not force one manifest write each.
                    chunk.telegramPushedBytes = pushed;
                    chunk.updatedAt = Date.now();
                }
                const { telegramBytesSent, telegramTotalBytes, processedBytes, totalBytes, percent, telegramBytesPerSecond, ...rest } = patch;
                publish({ ...current, ...rest });
            }, { ...(job.operationScope || req.diskScope), uploadId: job.id, operationId: job.operationId, signal,
                onState: async (state, details = {}) => {
                    if (state === 'unknown') job.recoveryDisposition = 'unknown';
                    const savedState = state === 'unknown' ? 'push_unknown' : state === 'failed' ? 'push_failed' : state;
                    await store.markProgressiveChunkState(job.id, fileIndex, chunk.partIndex, savedState, { ...details, attempts: details.attempt,
                        ...(['retry_wait', 'failed'].includes(state) ? { safeRetry: state === 'retry_wait', attemptIntent: null } : {}) });
                    if (['pushing', 'retry_wait'].includes(state)) { sentByPart.set(id, 0); chunk.telegramPushedBytes = 0; publish(); }
                },
                onFailure: error => {
                    job.pipelineFailure ||= error;
                    if (job.recoveryDisposition === 'unknown') job.pipelineFailure.details = { ...job.pipelineFailure.details, requestOutcomeUnknown: true };
                    try { operations.fail(job.operationId, job.pipelineFailure); }
                    catch (writeError) { log('upload.failure-state-write-failed', { uploadId: job.id, operationId: job.operationId, error: diskErrorDetails(writeError) }); }
                    job.pipelineAbort.abort(job.pipelineFailure); wake(job);
                },
                onRetry: details => publish({ ...current, phase: 'telegram-retry', message: `正在重试：${file.name} · 分片 ${chunk.partIndex}/${file.parts.length}`,
                    telegramRetryAt: details?.retryAt || 0 }),
                onReuseRejected: () => { try { chunkFileCache.remove(job.storage, part); } catch (_) {} },
                onConfirmed: async value => {
                    const accepted = { ...value, fileIndex, logicalFileId: file.logicalId, partIndex: chunk.partIndex,
                        partCount: file.parts.length, originalSize: file.size, offset: chunk.offset, size: chunk.size, sha256: chunk.sha256 || '' };
                    await store.markPartsUploaded(job.id, [accepted]);
                    try { if (accepted.sha256) chunkFileCache.put(job.storage, { ...part, sha256: accepted.sha256 }, accepted); }
                    catch (error) { log('telegram.chunk-cache-write-failed', { uploadId: job.id, fileId: file.logicalId, action: 'put', error: diskErrorDetails(error) }); }
                }
            });
            // The adapter's callback owns persistence before this point. Do not
            // release a staging quota or confirm a byte based on request EOF.
            if (!chunk.tempRemote) throw new Error('TELEGRAM_PUSH_CONFIRMATION_NOT_PERSISTED');
            sentByPart.set(id, chunk.size);
            publish({ ...current, phase: 'telegram-upload', message: `推送已确认：${file.name} · 分片 ${chunk.partIndex}/${file.parts.length}` });
            return remote;
        };
        try {
            while (true) {
                assertRunning();
                for (let fileIndex = 0; fileIndex < job.files.length && active.size < 2; fileIndex++) {
                    const file = job.files[fileIndex];
                    for (const chunk of file.chunks) {
                        if (active.size >= 2) break;
                        const id = key(fileIndex, chunk);
                        if (active.has(id) || chunk.tempRemote || chunk.remote || (!chunk.writtenBytes && !(chunk.sourceComplete && chunk.size === 0)) || chunk.sourceError) continue;
                        if (!['receiving', 'queued', 'source_complete', 'retry_wait'].includes(chunk.status)) continue;
                        const pending = push(file, fileIndex, chunk).catch(error => {
                            job.pipelineFailure ||= error;
                            if (error.unremovedParts?.length) job.pendingRollbackParts = [...new Map([
                                ...(job.pendingRollbackParts || []), ...error.unremovedParts
                            ].filter(part => part.messageId).map(part => [part.messageId, part])).values()];
                        })
                            .finally(() => { active.delete(id); wake(job); });
                        active.set(id, pending);
                    }
                }
                assertRunning();
                const finalIndex = job.files.findIndex((file, fileIndex) => !file.finalized && file.chunks.length === file.parts.length
                    && file.chunks.every(chunk => chunk.sourceComplete && Boolean(chunk.tempRemote) && !active.has(key(fileIndex, chunk))));
                if (finalIndex >= 0) {
                    const file = job.files[finalIndex];
                    publish({ phase: 'telegram-finalizing', telegramFileIndex: finalIndex + 1, telegramFileName: file.name,
                        message: `正在提交最终媒体组：${file.name}` });
                    try {
                        await telegram.finalizeGroups(job.storage, file, file.chunks.map(chunk => chunk.tempRemote), {
                            ...(job.operationScope || req.diskScope), uploadId: job.id, operationId: job.operationId, signal,
                            groups: (file.finalGroups || []).map(group => ({ ...group, groupIndex: group.index, parts: group.remotes || [] })),
                            onGroupStarted: (index, details) => store.markFinalGroupStarted(job.id, finalIndex, index, details),
                            onGroupRetry: (index, details) => store.markFinalGroupState(job.id, finalIndex, index, 'retry_wait', details),
                            onGroupFailure: (index, details) => store.markFinalGroupState(job.id, finalIndex, index, details.unknown ? 'unknown' : 'failed', details),
                            onGroupConfirmed: (group, index) => store.markFinalGroupUploaded(job.id, finalIndex, index, group),
                            update: patch => publish({ ...patch, phase: 'telegram-finalizing', telegramFileIndex: finalIndex + 1,
                                telegramFileName: file.name, message: `正在提交最终媒体组：${file.name}` })
                        });
                        await store.markProgressiveFinalized(job.id, finalIndex);
                    } catch (error) {
                        // Finalization recovery reuses persisted file IDs/groups.
                        // A failure must not destroy the only complete remote copy.
                        const unknown = error.message === 'UPLOAD_FINAL_RESULT_UNKNOWN' || file.finalGroups?.some(group => group.unknownResult || group.status === 'unknown'
                            || (group.intent && !group.remotes?.length));
                        job.recoveryDisposition = unknown ? 'unknown' : 'finalization'; throw error;
                    }
                    continue;
                }
                if (job.clientDone && !active.size && job.files.every(file => file.finalized)) {
                    for (let fileIndex = 0; fileIndex < job.files.length; fileIndex++) {
                        const file = job.files[fileIndex];
                        if (file.thumbnail?.status !== 'queued') continue;
                        const thumbnail = store.markThumbnailUploading(job.id, fileIndex);
                        publish({ phase: 'telegram-thumbnail', message: `正在上传媒体封面到 Telegram：${file.name}` });
                        let remote;
                        try {
                            const send = () => telegram.uploadThumbnail(job.storage, file, thumbnail, {
                                ...(job.operationScope || req.diskScope), uploadId: job.id, operationId: job.operationId, signal });
                            remote = telegram.scheduler ? await telegram.scheduler.enqueue(job.storage, send, { signal, taskKey: job.id }) : await send();
                        }
                        catch (error) {
                            assertRunning();
                            await store.failThumbnailAsync(job.id, fileIndex);
                            log('telegram.thumbnail-skipped', { uploadId: job.id, operationId: job.operationId, fileId: file.logicalId, error: diskErrorDetails(error) });
                            continue;
                        }
                        await store.markThumbnailUploadedAsync(job.id, fileIndex, remote);
                    }
                    assertRunning();
                    publish({ phase: 'index-write', message: '正在写入逻辑文件索引' });
                    return await commit(req, job, control);
                }
                await wait(job);
            }
        } catch (error) {
            job.pipelineFailure ||= error;
            if (job.recoveryDisposition === 'unknown') job.pipelineFailure.details = { ...job.pipelineFailure.details, requestOutcomeUnknown: true };
            job.pipelineError = diskErrorCode(job.pipelineFailure);
            job.pipelineAbort.abort(); wake(job);
            if (!control.cancelled) {
                try { operations.fail(job.operationId, job.pipelineFailure); }
                catch (writeError) { log('upload.failure-state-write-failed', { uploadId: job.id, operationId: job.operationId, error: diskErrorDetails(writeError) }); }
            }
            await Promise.allSettled([...active.values()]);
            if (!control.cancelled && job.files.some(file => file.chunks.some(chunk => !chunk.tempRemote
                && (chunk.unknownResult || chunk.attemptIntent?.bodyComplete || chunk.status === 'awaiting_response')))) job.recoveryDisposition = 'unknown';
            try {
                const extra = [...(job.pendingRollbackParts || []), ...(error.unremovedParts || [])];
                if (extra.length) {
                    try { await store.keepUploadRollbackParts(job.id, extra); }
                    catch (writeError) { log('upload.recovery-manifest-failed', { uploadId: job.id, operationId: job.operationId, error: diskErrorDetails(writeError) }); }
                }
                if (control.cancelled || job.pipelineFailure.message === 'OPERATION_CANCELLED') {
                    job.recoveryDisposition = 'rollback';
                    try { await store.setUploadContextAsync(job.id, { recoveryDisposition: 'rollback' }); } catch (_) {}
                    await rollback(job, store, 'upload.cancel-cleanup-failed');
                } else {
                    log('upload.progressive-failed', { uploadId: job.id, operationId: job.operationId,
                        disposition: job.recoveryDisposition || 'rollback', error: diskErrorDetails(job.pipelineFailure), code: job.pipelineError });
                    if (['unknown', 'finalization'].includes(job.recoveryDisposition)) {
                        try { await store.setUploadContextAsync(job.id, { recoveryDisposition: job.recoveryDisposition, recoveryErrorCode: job.pipelineError }); }
                        finally { await store.preserveForRecoveryAsync(job.id); }
                    } else await rollback(job, store, 'upload.failure-cleanup-failed');
                }
            } catch (cleanupError) {
                log('upload.failure-recovery-failed', { uploadId: job.id, operationId: job.operationId, error: diskErrorDetails(cleanupError), originalCode: job.pipelineError });
            }
            throw job.pipelineFailure;
        } finally { wake(job); job.pipelineDoneResolve?.(); }
    };
}
module.exports = { createProgressiveUploadRunner };
