'use strict';
const express = require('express');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const rateLimit = require('express-rate-limit');
const { verify, decodeAwsChunks, sha256 } = require('./sigv4');
const { esc, tag, document, deleteRequest } = require('./xml');
const { createS3Credentials } = require('./credentials');

const MESSAGES = {
    NoSuchBucket: 'The specified bucket does not exist.', NoSuchKey: 'The specified key does not exist.',
    AccessDenied: 'Access denied.', InvalidAccessKeyId: 'The AWS Access Key Id you provided does not exist.',
    SignatureDoesNotMatch: 'The request signature we calculated does not match.', InvalidArgument: 'Invalid argument.',
    InvalidRange: 'The requested range is not satisfiable.', EntityTooLarge: 'Object exceeds the upload limit.',
    InvalidObjectName: 'The object key cannot be represented by this storage.', NotImplemented: 'The requested feature is not implemented.',
    IncompleteBody: 'The request body ended before the expected number of bytes were received.',
    XAmzContentSHA256Mismatch: 'The provided payload hash does not match the request body.',
    RequestTimeTooSkewed: 'The difference between request time and server time is too large.',
    MalformedXML: 'The XML you provided was not well-formed.', InternalError: 'An internal error occurred.'
};
MESSAGES.OperationAborted = 'A conflicting operation is in progress.';
MESSAGES.SlowDown = 'Please reduce your request rate.';
MESSAGES.BadDigest = 'The Content-MD5 you specified did not match what we received.';
const STATUS = { NoSuchBucket: 404, NoSuchKey: 404, InvalidAccessKeyId: 403, AccessDenied: 403, SignatureDoesNotMatch: 403,
    InvalidArgument: 400, InvalidRange: 416, EntityTooLarge: 413, InvalidObjectName: 400, NotImplemented: 501,
    IncompleteBody: 400, XAmzContentSHA256Mismatch: 400, RequestTimeTooSkewed: 403, MalformedXML: 400, OperationAborted: 409, SlowDown: 503, BadDigest: 400 };
const iso = value => new Date(Number(value) || Date.now()).toISOString();
const uri = value => encodeURIComponent(value).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
function partsFromRequest(req, mount) {
    const path = (req.originalUrl || req.url).split('?')[0];
    if (!path.startsWith(mount)) throw new Error('InvalidArgument');
    const rest = path.slice(mount.length);
    if (rest && !rest.startsWith('/')) throw new Error('InvalidArgument');
    const suffix = rest ? rest.slice(1) : '';
    if (suffix.startsWith('/')) throw new Error('InvalidArgument');
    if (!suffix) return { bucket: '', key: '' };
    const at = suffix.indexOf('/');
    try {
        return { bucket: decodeURIComponent(at < 0 ? suffix : suffix.slice(0, at)),
            key: at < 0 ? '' : suffix.slice(at + 1).split('/').map(decodeURIComponent).join('/') };
    } catch (_) { throw new Error('InvalidArgument'); }
}
function token(secret, data) {
    const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
    return payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}
function untoken(secret, encoded) {
    const [payload, signature] = String(encoded || '').split('.');
    if (!payload || !signature) throw new Error('InvalidArgument');
    const correct = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    const a = Buffer.from(signature), b = Buffer.from(correct);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('InvalidArgument');
    try { return JSON.parse(Buffer.from(payload, 'base64url').toString()); }
    catch (_) { throw new Error('InvalidArgument'); }
}
function listV2({ objects, bucket, query, secret }) {
    const prefix = String(query.prefix || ''), delimiter = String(query.delimiter || ''), startAfter = String(query['start-after'] || '');
    const encoding = String(query['encoding-type'] || '');
    if (encoding && encoding !== 'url') throw new Error('InvalidArgument');
    const rawMax = query['max-keys'] === undefined ? 1000 : Number(query['max-keys']);
    if (!Number.isSafeInteger(rawMax) || rawMax < 0) throw new Error('InvalidArgument');
    const max = Math.min(rawMax, 1000), continuation = String(query['continuation-token'] || '');
    const anchor = continuation ? untoken(secret, continuation) : null;
    if (anchor && (anchor.bucket !== bucket || anchor.prefix !== prefix || anchor.delimiter !== delimiter || typeof anchor.after !== 'string')) throw new Error('InvalidArgument');
    const after = anchor?.after ?? startAfter;
    const groups = new Map(), items = [];
    for (const object of objects) {
        if (object.kind === 'virtual-directory' && !delimiter) continue;
        if (!object.key.startsWith(prefix) || object.key <= after) continue;
        const rest = object.key.slice(prefix.length), at = delimiter ? rest.indexOf(delimiter) : -1;
        if (at >= 0) {
            const key = prefix + rest.slice(0, at + delimiter.length);
            if (key <= after) continue;
            const item = groups.get(key);
            if (item) item.lastKey = object.key;
            else groups.set(key, { kind: 'prefix', key, lastKey: object.key });
        } else if (object.kind !== 'virtual-directory') items.push({ kind: 'object', key: object.key, lastKey: object.key, object });
    }
    const ordered = [...items, ...groups.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const page = ordered.slice(0, max), truncated = max > 0 && ordered.length > max;
    const display = value => encoding === 'url' ? uri(value) : value;
    const content = page.map(item => item.kind === 'prefix' ? `<CommonPrefixes>${tag('Prefix', display(item.key))}</CommonPrefixes>`
        : `<Contents>${tag('Key', display(item.key))}${tag('LastModified', iso(item.object.updatedAt))}${tag('ETag', `"${item.object.etag}"`)}${tag('Size', item.object.size)}${tag('StorageClass', 'STANDARD')}</Contents>`).join('');
    const next = truncated && page.length ? token(secret, { bucket, prefix, delimiter, after: page.at(-1).lastKey }) : '';
    return document('ListBucketResult', tag('Name', bucket) + tag('Prefix', display(prefix)) + tag('KeyCount', page.length) + tag('MaxKeys', max) + tag('IsTruncated', truncated) +
        (delimiter ? tag('Delimiter', display(delimiter)) : '') + (encoding ? tag('EncodingType', encoding) : '') + (startAfter ? tag('StartAfter', display(startAfter)) : '') +
        (continuation ? tag('ContinuationToken', continuation) : '') + (next ? tag('NextContinuationToken', next) : '') + content);
}
function listV1({ objects, bucket, query }) {
    const prefix = String(query.prefix || ''), delimiter = String(query.delimiter || ''), marker = String(query.marker || '');
    const encoding = String(query['encoding-type'] || '');
    if (encoding && encoding !== 'url') throw new Error('InvalidArgument');
    const rawMax = query['max-keys'] === undefined ? 1000 : Number(query['max-keys']);
    if (!Number.isSafeInteger(rawMax) || rawMax < 0) throw new Error('InvalidArgument');
    const max = Math.min(rawMax, 1000), groups = new Map(), items = [];
    for (const object of objects) {
        if (object.kind === 'virtual-directory' && !delimiter) continue;
        if (!object.key.startsWith(prefix) || object.key <= marker) continue;
        const rest = object.key.slice(prefix.length), at = delimiter ? rest.indexOf(delimiter) : -1;
        if (at >= 0) {
            const key = prefix + rest.slice(0, at + delimiter.length);
            if (key <= marker) continue;
            const existing = groups.get(key);
            if (existing) existing.lastKey = object.key;
            else groups.set(key, { kind: 'prefix', key, lastKey: object.key });
        } else if (object.kind !== 'virtual-directory') items.push({ kind: 'object', key: object.key, lastKey: object.key, object });
    }
    const ordered = [...items, ...groups.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const page = ordered.slice(0, max), truncated = max > 0 && ordered.length > max;
    const display = value => encoding === 'url' ? uri(value) : value;
    const content = page.map(item => item.kind === 'prefix' ? `<CommonPrefixes>${tag('Prefix', display(item.key))}</CommonPrefixes>`
        : `<Contents>${tag('Key', display(item.key))}${tag('LastModified', iso(item.object.updatedAt))}${tag('ETag', `"${item.object.etag}"`)}${tag('Size', item.object.size)}${tag('StorageClass', 'STANDARD')}</Contents>`).join('');
    const next = truncated && delimiter && page.length ? tag('NextMarker', display(page.at(-1).key)) : '';
    return document('ListBucketResult', tag('Name', bucket) + tag('Prefix', display(prefix)) + tag('Marker', display(marker))
        + tag('MaxKeys', max) + tag('IsTruncated', truncated) + (delimiter ? tag('Delimiter', display(delimiter)) : '')
        + (encoding ? tag('EncodingType', encoding) : '') + next + content);
}
async function readLimited(req, limit) {
    const chunks = []; let total = 0;
    for await (const chunk of req) { total += chunk.length; if (total > limit) throw new Error('EntityTooLarge'); chunks.push(chunk); }
    return Buffer.concat(chunks);
}
function createS3Gateway({ dataDir, objectStorage }) {
    const credentials = createS3Credentials(dataDir), api = express.Router(), content = express.Router();
    const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10000, standardHeaders: false, legacyHeaders: false,
        validate: { xForwardedForHeader: false },
        handler(req, res) { const id = crypto.randomBytes(12).toString('hex'); res.status(503).set({ 'Retry-After': '60', 'x-amz-request-id': id }).type('application/xml').send(document('Error', tag('Code', 'SlowDown') + tag('Message', MESSAGES.SlowDown) + tag('RequestId', id))); } });
    api.use(limiter); content.use(limiter);
    async function dispatch(req, res, mount, contentOnly) {
        const requestId = crypto.randomBytes(12).toString('hex');
        res.set({ 'x-amz-request-id': requestId, 'Cache-Control': 'private, no-store' });
        let selected;
        try {
            const auth = verify(req, credentials);
            if (Object.keys(req.headers).some(name => name.startsWith('x-amz-server-side-encryption') || name.startsWith('x-amz-object-lock'))
                || req.headers['x-amz-acl'] || req.headers['x-amz-tagging'] || req.headers['x-amz-tagging-directive']
                || req.headers['x-amz-storage-class'] && req.headers['x-amz-storage-class'] !== 'STANDARD'
                || req.headers['x-amz-metadata-directive'] && req.headers['x-amz-metadata-directive'] !== 'COPY') throw new Error('NotImplemented');
            const { bucket, key } = partsFromRequest(req, mount), mappings = auth.credential.bucketMappings || [];
            const mapping = mappings.find(item => item.bucket === bucket);
            if (!bucket) {
                if (contentOnly || req.method !== 'GET') throw new Error('NotImplemented');
                return res.type('application/xml').send(document('ListAllMyBucketsResult', `<Owner>${tag('ID', auth.credential.userId)}${tag('DisplayName', auth.credential.userId)}</Owner><Buckets>` + mappings.map(item => `<Bucket>${tag('Name', item.bucket)}${tag('CreationDate', iso(auth.credential.createdAt))}</Bucket>`).join('') + '</Buckets>'));
            }
            if (!mapping) throw new Error('NoSuchBucket');
            // SigV4 authenticates the request at entry. A long upload or Copy
            // must also see credential disable/rotation or mapping edits before
            // publishing its Logical File.
            const authorizeMapping = bucketMapping => ({ ...bucketMapping, userId: auth.credential.userId,
                assertAuthorized() {
                    const current = credentials.find(auth.accessKeyId);
                    if (!current || current.updatedAt !== auth.credential.updatedAt
                        || current.secretAccessKey !== auth.credential.secretAccessKey
                        || current.userId !== auth.credential.userId) throw new Error('AccessDenied');
                    const active = current?.bucketMappings?.find(item => item.bucket === bucketMapping.bucket);
                    if (!active || active.diskSpace !== bucketMapping.diskSpace
                        || String(active.backendId || '') !== String(bucketMapping.backendId || '')) throw new Error('AccessDenied');
                } });
            selected = authorizeMapping(mapping);
            const query = Object.fromEntries(new URL(req.originalUrl, 'http://localhost').searchParams);
            if (!key) {
                if (contentOnly) throw new Error('NotImplemented');
                if (req.method === 'HEAD') return res.status(200).set('x-amz-bucket-region', auth.region).end();
                if (req.method === 'GET' && Object.hasOwn(query, 'location')) return res.type('application/xml').send(document('LocationConstraint', esc(auth.region === 'us-east-1' ? '' : auth.region)));
                if (req.method === 'GET' && query['list-type'] === '2') return res.type('application/xml').send(listV2({ objects: objectStorage.list(selected), bucket, query, secret: auth.credential.secretAccessKey }));
                if (req.method === 'GET' && !Object.hasOwn(query, 'list-type') && !Object.hasOwn(query, 'uploads') && !Object.hasOwn(query, 'versions'))
                    return res.type('application/xml').send(listV1({ objects: objectStorage.list(selected), bucket, query }));
                if (req.method === 'POST' && Object.hasOwn(query, 'delete')) {
                    const bytes = await readLimited(req, 1024 * 1024);
                    if (auth.payloadHash !== 'UNSIGNED-PAYLOAD' && sha256(bytes) !== auth.payloadHash) throw new Error('XAmzContentSHA256Mismatch');
                    const parsed = deleteRequest(bytes.toString('utf8'));
                    const results = [];
                    for (const name of parsed.keys) {
                        try { await objectStorage.remove(selected, name); if (!parsed.quiet) results.push(`<Deleted>${tag('Key', name)}</Deleted>`); }
                        catch (error) { results.push(`<Error>${tag('Key', name)}${tag('Code', MESSAGES[error.message] ? error.message : 'InternalError')}${tag('Message', MESSAGES[error.message] || MESSAGES.InternalError)}</Error>`); }
                    }
                    return res.type('application/xml').send(document('DeleteResult', results.join('')));
                }
                throw new Error('NotImplemented');
            }
            if (contentOnly && !['GET', 'HEAD'].includes(req.method)) throw new Error('NotImplemented');
            if (req.method === 'PUT' && req.headers['x-amz-copy-source']) {
                if (auth.payloadHash !== 'UNSIGNED-PAYLOAD' && auth.payloadHash !== sha256('')) throw new Error('XAmzContentSHA256Mismatch');
                if (Number(req.headers['content-length'] || 0) !== 0) throw new Error('InvalidArgument');
                const copy = String(req.headers['x-amz-copy-source']).split('?')[0];
                if (!copy.startsWith('/')) throw new Error('InvalidArgument');
                const at = copy.indexOf('/', 1);
                if (at < 0) throw new Error('InvalidArgument');
                let sourceBucket, sourceKey;
                try { sourceBucket = decodeURIComponent(copy.slice(1, at)); sourceKey = copy.slice(at + 1).split('/').map(decodeURIComponent).join('/'); }
                catch (_) { throw new Error('InvalidArgument'); }
                const sourceMapping = mappings.find(item => item.bucket === sourceBucket);
                if (!sourceMapping) throw new Error('NoSuchBucket');
                const copied = await objectStorage.copy(authorizeMapping(sourceMapping), sourceKey, selected, key);
                const object = copied?.etag ? copied : objectStorage.stat(selected, key);
                return res.type('application/xml').send(document('CopyObjectResult', tag('LastModified', iso(object.updatedAt)) + tag('ETag', `"${object.etag}"`)));
            }
            if (req.method === 'PUT') {
                const chunked = auth.payloadHash === 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD';
                const size = Number(chunked ? req.headers['x-amz-decoded-content-length'] : req.headers['content-length']);
                if (!Number.isSafeInteger(size) || size < 0) throw new Error('InvalidArgument');
                const metadata = Object.fromEntries(Object.entries(req.headers).filter(([name, value]) => name.startsWith('x-amz-meta-') && typeof value === 'string' && name.length <= 100 && value.length <= 2048));
                const object = await objectStorage.put(selected, key, decodeAwsChunks(req, auth), { size, contentType: String(req.headers['content-type'] || 'application/octet-stream').slice(0, 120), expectedSha256: chunked ? '' : auth.payloadHash, expectedMd5: String(req.headers['content-md5'] || ''), metadata });
                return res.status(200).set('ETag', `"${object.etag}"`).end();
            }
            if (req.method === 'DELETE') { await objectStorage.remove(selected, key); return res.status(204).end(); }
            if (req.method === 'GET' || req.method === 'HEAD') {
                const object = objectStorage.stat(selected, key);
                if (!object) throw new Error('NoSuchKey');
                const range = objectStorage.parseByteRange(req.headers.range, object.size);
                const length = range.end - range.start + 1;
                res.status(range.partial ? 206 : 200).set({ 'Accept-Ranges': 'bytes', 'Content-Type': object.type,
                    'Content-Length': String(Math.max(0, length)), 'ETag': `"${object.etag}"`, 'Last-Modified': new Date(object.updatedAt).toUTCString() });
                for (const [name, value] of Object.entries(object.kind === 'marker' ? object.directory.s3Marker.metadata || {} : object.file.metadata || {}))
                    if (name.startsWith('x-amz-meta-') && typeof value === 'string') res.set(name, value);
                if (range.partial) res.set('Content-Range', `bytes ${range.start}-${range.end}/${object.size}`);
                if (req.method === 'HEAD') return res.end();
                const abort = new AbortController();
                res.on('close', () => { if (!res.writableEnded) abort.abort(); });
                const opened = await objectStorage.open(selected, key, req.headers.range, abort.signal);
                return pipeline(opened.stream, res);
            }
            throw new Error('NotImplemented');
        } catch (error) {
            if (res.headersSent) return res.destroy(error);
            const code = error.message === 'DISK_NAME_CONFLICT' ? 'OperationAborted' : MESSAGES[error.message] ? error.message : 'InternalError';
            if (code === 'InternalError') console.warn('[s3] request failed', { requestId, error: error.message });
            if (code === 'InvalidRange' && selected) {
                try { const object = objectStorage.stat(selected, partsFromRequest(req, mount).key); if (object) res.set('Content-Range', `bytes */${object.size}`); } catch (_) {}
            }
            res.status(STATUS[code] || 500).type('application/xml');
            if (req.method === 'HEAD') return res.end();
            res.send(document('Error', tag('Code', code) + tag('Message', MESSAGES[code]) + tag('RequestId', requestId)));
        }
    }
    api.use((req, res) => { dispatch(req, res, '/S3API', false).catch(error => { if (!res.headersSent) res.status(500).end(); else res.destroy(error); }); });
    content.use((req, res) => { dispatch(req, res, '/s3', true).catch(error => { if (!res.headersSent) res.status(500).end(); else res.destroy(error); }); });
    return { api, content, credentials };
}
module.exports = { createS3Gateway, listV1, listV2, partsFromRequest };
