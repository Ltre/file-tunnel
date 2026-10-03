'use strict';

const fs = require('fs/promises');
const { Readable } = require('stream');

const abortError = () => {
    const error = new Error('OPERATION_CANCELLED');
    error.name = 'AbortError';
    return error;
};

function createGrowingFileReadable({ path, size, getWrittenBytes, waitForGrowth, getSourceError = () => null, signal, readSize = 256 * 1024 }) {
    if (!path || !Number.isSafeInteger(size) || size < 0 || typeof getWrittenBytes !== 'function' || typeof waitForGrowth !== 'function') throw new Error('TELEGRAM_GROWING_SOURCE_INVALID');
    async function* read() {
        let handle, offset = 0;
        try {
            handle = await fs.open(path, 'r');
            while (offset < size) {
                if (signal?.aborted) throw abortError();
                const sourceError = getSourceError();
                if (sourceError) throw sourceError instanceof Error ? sourceError : new Error(String(sourceError));
                const written = Math.max(0, Math.min(size, Number(getWrittenBytes()) || 0));
                if (offset >= written) {
                    await waitForGrowth(offset, signal);
                    continue;
                }
                const wanted = Math.min(readSize, written - offset, size - offset);
                const buffer = Buffer.allocUnsafe(wanted);
                const { bytesRead } = await handle.read(buffer, 0, wanted, offset);
                if (!bytesRead) {
                    await waitForGrowth(offset, signal);
                    continue;
                }
                offset += bytesRead;
                yield bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
            }
            if (offset !== size) throw new Error('TELEGRAM_PART_SIZE_MISMATCH');
        } finally {
            await handle?.close().catch(() => {});
        }
    }
    return Readable.from(read());
}

module.exports = { createGrowingFileReadable };
