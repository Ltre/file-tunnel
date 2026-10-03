'use strict';

const fsp = require('node:fs/promises');
const { Readable } = require('node:stream');

const cancelled = () => Object.assign(new Error('OPERATION_CANCELLED'), { code: 'OPERATION_CANCELLED' });
const mismatch = () => Object.assign(new Error('TELEGRAM_PART_SIZE_MISMATCH'), { code: 'TELEGRAM_PART_SIZE_MISMATCH' });
const asError = error => error instanceof Error ? error : Object.assign(new Error(error?.message || error?.code || 'UPLOAD_SOURCE_FAILED'), error || {});

function notifyGrowingFile(source) {
    source.growthRevision = (source.growthRevision || 0) + 1;
    for (const wake of source.growthWaiters || []) wake();
    source.growthWaiters?.clear();
}

function waitForGrowth(source, revision, signal) {
    if (signal?.aborted) return Promise.reject(cancelled());
    if ((source.growthRevision || 0) !== revision) return Promise.resolve();
    return new Promise((resolve, reject) => {
        source.growthWaiters ||= new Set();
        const finish = error => {
            source.growthWaiters.delete(wake);
            signal?.removeEventListener('abort', abort);
            error ? reject(error) : resolve();
        };
        const wake = () => finish();
        const abort = () => finish(cancelled());
        source.growthWaiters.add(wake);
        signal?.addEventListener('abort', abort, { once: true });
        // A producer notification between the first check and registration must
        // not leave the reader waiting until some unrelated later append.
        if ((source.growthRevision || 0) !== revision) wake();
        else if (signal?.aborted) abort();
    });
}

async function awaitGrowingFileComplete(source, signal) {
    for (;;) {
        if (signal?.aborted) throw cancelled();
        if (source.sourceError) throw asError(source.sourceError);
        if (source.sourceComplete) {
            if (source.writtenBytes !== source.size) throw mismatch();
            return source;
        }
        const revision = source.growthRevision || 0;
        await waitForGrowth(source, revision, signal);
    }
}

function createGrowingFileReadable(source, signal) {
    if (!Number.isSafeInteger(source.size) || source.size < 0) throw mismatch();
    source.readers ||= new Set();
    let handle, released;
    const done = new Promise(resolve => { released = resolve; });
    const registration = { stream: null, done };
    source.readers.add(registration);
    async function* read() {
        let offset = 0;
        try {
            handle = await fsp.open(source.path, 'r');
            for (;;) {
                if (signal?.aborted || registration.cancelled) throw registration.cancelled || cancelled();
                if (source.sourceError) throw asError(source.sourceError);
                const available = Math.min(source.size, source.writtenBytes || 0) - offset;
                if (available > 0) {
                    const bytes = Buffer.allocUnsafe(Math.min(64 * 1024, available));
                    const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
                    // writtenBytes is advanced only after an actual write has
                    // completed. A short/empty read therefore indicates damage.
                    if (!bytesRead) throw mismatch();
                    offset += bytesRead;
                    yield bytes.subarray(0, bytesRead);
                    continue;
                }
                if (source.sourceComplete) {
                    if (source.writtenBytes !== source.size || offset !== source.size) throw mismatch();
                    return;
                }
                // Reaching the advertised length is not permission to emit EOF:
                // size, hash and manifest validation must also have succeeded.
                const revision = source.growthRevision || 0;
                await waitForGrowth(source, revision, signal);
            }
        } finally {
            await handle?.close();
        }
    }
    const stream = registration.stream = Readable.from(read(), { objectMode: false, highWaterMark: 64 * 1024 });
    const destroy = stream.destroy;
    stream.destroy = function(error) {
        // Readable.from waits for a pending generator.next() during destroy.
        // Wake that wait even when the consumer destroys without an AbortSignal.
        registration.cancelled = error || cancelled();
        notifyGrowingFile(source);
        return destroy.call(this, error);
    };
    const abort = () => stream.destroy(cancelled());
    stream.on('error', () => {});
    stream.once('close', () => {
        signal?.removeEventListener('abort', abort);
        source.readers.delete(registration);
        released();
        source.onReadersClosed?.();
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) stream.destroy(cancelled());
    return stream;
}

function stopGrowingReaders(source, error = cancelled()) {
    for (const reader of source.readers || []) { reader.cancelled = error; reader.stream.destroy(error); }
    notifyGrowingFile(source);
}

async function awaitGrowingReadersClosed(source) {
    await Promise.all([...(source.readers || [])].map(reader => reader.done));
}

module.exports = { createGrowingFileReadable, notifyGrowingFile, awaitGrowingFileComplete, stopGrowingReaders, awaitGrowingReadersClosed };
