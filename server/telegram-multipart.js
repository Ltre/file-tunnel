const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

function sanitizeMultipartHeaderValue(value) {
    return String(value || '').replace(/[\r\n]/g, ' ').replace(/"/g, '%22');
}

function getAudioContentType(fileName = '') {
    const ext = path.extname(String(fileName || '')).slice(1).toLowerCase();
    if (ext === 'mp3') return 'audio/mpeg';
    if (ext === 'm4a' || ext === 'mp4') return 'audio/mp4';
    if (ext === 'aac') return 'audio/aac';
    if (ext === 'ogg' || ext === 'opus') return 'audio/ogg';
    if (ext === 'wav') return 'audio/wav';
    if (ext === 'flac') return 'audio/flac';
    if (ext === 'webm') return 'audio/webm';
    return 'application/octet-stream';
}

function getDocumentContentType(fileName = '', fallback = '') {
    return String(fallback || getAudioContentType(fileName) || 'application/octet-stream');
}

function buildTelegramDocumentsMultipart({ chatId, caption = '', files = [], onProgress }) {
    if (!chatId || !files.length) throw new Error('telegram-drive-multipart-invalid');
    const normalized = files.map((file, index) => ({
        fieldName: files.length === 1 ? 'document' : `file${index}`,
        fileName: file.name || `file-${index + 1}`,
        path: file.path,
        caption: file.caption,
        type: getDocumentContentType(file.name, file.type),
        size: fs.statSync(file.path).size
    }));
    const fields = files.length === 1
        ? { chat_id: chatId, caption: normalized[0].caption ?? caption }
        : { chat_id: chatId, media: JSON.stringify(normalized.map((file, index) => ({ type: 'document', media: `attach://${file.fieldName}`, caption: file.caption ?? (index === 0 ? caption : '') }))) };
    const boundary = `----Drop2Tunnel${crypto.randomBytes(18).toString('hex')}`;
    const parts = []; let contentLength = 0;
    const addBuffer = value => { const buffer = Buffer.from(value, 'utf8'); parts.push({ buffer }); contentLength += buffer.length; };
    for (const [name, value] of Object.entries(fields)) addBuffer(`--${boundary}\r\nContent-Disposition: form-data; name="${sanitizeMultipartHeaderValue(name)}"\r\n\r\n${String(value || '')}\r\n`);
    normalized.forEach(file => { const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${sanitizeMultipartHeaderValue(file.fileName)}"\r\nContent-Type: ${file.type}\r\n\r\n`); parts.push({ header, file }); contentLength += header.length + file.size + 2; });
    const closing = Buffer.from(`--${boundary}--\r\n`); contentLength += closing.length;
    async function* generate() { let sent = 0; const total = normalized.reduce((sum, file) => sum + file.size, 0); for (const part of parts) { if (part.buffer) { yield part.buffer; continue; } yield part.header; for await (const chunk of fs.createReadStream(part.file.path)) { sent += chunk.length; onProgress?.(sent, total, part.file.fileName); yield chunk; } yield Buffer.from('\r\n'); } yield closing; }
    return { method: files.length === 1 ? 'sendDocument' : 'sendMediaGroup', body: Readable.from(generate()), contentLength, contentType: `multipart/form-data; boundary=${boundary}` };
}

function buildTelegramAudioMultipart({ fields, audioPath, audioFileName, thumbnailPath, onAudioProgress }) {
    const boundary = `----Drop2Tunnel${crypto.randomBytes(18).toString('hex')}`;
    const chunks = [];
    const add = value => {
        const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
        chunks.push({ kind: 'buffer', buffer });
        return buffer.length;
    };
    let contentLength = 0;

    for (const [name, rawValue] of Object.entries(fields || {})) {
        if (rawValue === undefined || rawValue === null || rawValue === '') continue;
        contentLength += add(`--${boundary}\r\nContent-Disposition: form-data; name="${sanitizeMultipartHeaderValue(name)}"\r\n\r\n${String(rawValue)}\r\n`);
    }

    const files = [];
    if (thumbnailPath) {
        const stat = fs.statSync(thumbnailPath);
        files.push({ fieldName: 'thumbnail', fileName: 'thumbnail.jpg', path: thumbnailPath, type: 'image/jpeg', size: stat.size, trackAudio: false });
    }
    const audioStat = fs.statSync(audioPath);
    files.push({
        fieldName: 'audio',
        fileName: audioFileName || 'song.m4a',
        path: audioPath,
        type: getAudioContentType(audioFileName || audioPath),
        size: audioStat.size,
        trackAudio: true
    });

    for (const file of files) {
        const header = Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${sanitizeMultipartHeaderValue(file.fileName)}"\r\nContent-Type: ${file.type}\r\n\r\n`,
            'utf8'
        );
        chunks.push({ kind: 'file', header, file });
        contentLength += header.length + file.size + 2;
    }
    const closing = Buffer.from(`--${boundary}--\r\n`, 'utf8');
    contentLength += closing.length;

    async function* generate() {
        let uploadedAudioBytes = 0;
        for (const chunk of chunks) {
            if (chunk.kind === 'buffer') {
                yield chunk.buffer;
                continue;
            }
            yield chunk.header;
            for await (const fileChunk of fs.createReadStream(chunk.file.path)) {
                yield fileChunk;
                if (chunk.file.trackAudio) {
                    uploadedAudioBytes += fileChunk.length;
                    onAudioProgress?.(Math.min(uploadedAudioBytes, chunk.file.size), chunk.file.size);
                }
            }
            yield Buffer.from('\r\n');
        }
        yield closing;
    }

    return {
        body: Readable.from(generate()),
        contentLength,
        contentType: `multipart/form-data; boundary=${boundary}`,
        audioSize: audioStat.size,
        thumbnailSize: files.find(file => !file.trackAudio)?.size || 0
    };
}

module.exports = { buildTelegramAudioMultipart, buildTelegramDocumentsMultipart };
