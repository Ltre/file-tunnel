'use strict';
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();
const safeEqual = (a, b) => {
    const left = Buffer.from(String(a), 'hex'), right = Buffer.from(String(b), 'hex');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
};
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
function decode(value) { try { return decodeURIComponent(value); } catch (_) { throw new Error('InvalidArgument'); } }
function canonicalUri(url) {
    return url.split('?')[0].split('/').map(segment => encode(decode(segment))).join('/');
}
function canonicalQuery(url) {
    const raw = url.split('?').slice(1).join('?');
    if (!raw) return '';
    return raw.split('&').map(pair => {
        const at = pair.indexOf('=');
        return [encode(decode(at < 0 ? pair : pair.slice(0, at))), encode(decode(at < 0 ? '' : pair.slice(at + 1)))];
    }).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)
        .map(([name, value]) => `${name}=${value}`).join('&');
}
function signingKey(secret, date, region) {
    return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), 's3'), 'aws4_request');
}
function verify(req, credentials, now = Date.now()) {
    const authorization = String(req.headers.authorization || '');
    const match = /^AWS4-HMAC-SHA256 Credential=([^/\s,]+)\/(\d{8})\/([a-z0-9-]+)\/s3\/aws4_request,\s*SignedHeaders=([a-z0-9;-]+),\s*Signature=([a-f0-9]{64})$/i.exec(authorization);
    if (!match) throw new Error('AccessDenied');
    const [, accessKeyId, date, region, signedRaw, signature] = match;
    const credential = credentials.find(accessKeyId);
    if (!credential) throw new Error('InvalidAccessKeyId');
    const signed = signedRaw.split(';');
    if (new Set(signed).size !== signed.length || signed.join(';') !== [...signed].sort().join(';') || !signed.includes('host') || !signed.includes('x-amz-date')) throw new Error('SignatureDoesNotMatch');
    const amzDate = String(req.headers['x-amz-date'] || '');
    if (!/^\d{8}T\d{6}Z$/.test(amzDate) || amzDate.slice(0, 8) !== date || !Number.isFinite(Date.parse(amzDate.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'))) || Math.abs(now - Date.parse(amzDate.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'))) > 15 * 60 * 1000) throw new Error('RequestTimeTooSkewed');
    const payloadHash = String(req.headers['x-amz-content-sha256'] || '');
    if (!/^(?:[a-f0-9]{64}|UNSIGNED-PAYLOAD|STREAMING-AWS4-HMAC-SHA256-PAYLOAD)$/.test(payloadHash)) throw new Error('InvalidArgument');
    const headers = signed.map(name => {
        const value = req.headers[name];
        if (value === undefined) throw new Error('SignatureDoesNotMatch');
        return `${name}:${String(Array.isArray(value) ? value.join(',') : value).trim().replace(/\s+/g, ' ')}\n`;
    }).join('');
    const canonical = [req.method.toUpperCase(), canonicalUri(req.originalUrl || req.url), canonicalQuery(req.originalUrl || req.url), headers, signedRaw, payloadHash].join('\n');
    const scope = `${date}/${region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
    const key = signingKey(credential.secretAccessKey, date, region);
    if (!safeEqual(hmac(key, stringToSign).toString('hex'), signature)) throw new Error('SignatureDoesNotMatch');
    return { credential, accessKeyId, region, scope, date: amzDate, payloadHash, signature, signingKey: key };
}

function decodeAwsChunks(request, auth) {
    if (auth.payloadHash !== 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD') return request;
    const iterator = request[Symbol.asyncIterator]();
    let pending = Buffer.alloc(0);
    async function take(count) {
        while (pending.length < count) {
            const next = await iterator.next();
            if (next.done) throw new Error('IncompleteBody');
            pending = Buffer.concat([pending, Buffer.from(next.value)]);
            if (pending.length > 24 * 1024 * 1024) throw new Error('EntityTooLarge');
        }
        const result = pending.subarray(0, count); pending = pending.subarray(count); return result;
    }
    async function* chunks() {
        let previous = auth.signature, decoded = 0;
        while (true) {
            let line = Buffer.alloc(0);
            while (true) {
                const byte = await take(1); line = Buffer.concat([line, byte]);
                if (line.length > 256) throw new Error('InvalidArgument');
                if (line.length >= 2 && line.at(-2) === 13 && line.at(-1) === 10) break;
            }
            const header = /^([a-f0-9]+);chunk-signature=([a-f0-9]{64})\r\n$/i.exec(line.toString('ascii'));
            if (!header) throw new Error('SignatureDoesNotMatch');
            const length = parseInt(header[1], 16);
            if (!Number.isSafeInteger(length) || length > 20_000_000) throw new Error('EntityTooLarge');
            const body = await take(length);
            if ((await take(2)).toString() !== '\r\n') throw new Error('InvalidArgument');
            const sign = ['AWS4-HMAC-SHA256-PAYLOAD', auth.date, auth.scope, previous, sha256(''), sha256(body)].join('\n');
            if (!safeEqual(hmac(auth.signingKey, sign).toString('hex'), header[2])) throw new Error('SignatureDoesNotMatch');
            previous = header[2]; decoded += length;
            if (!length) break;
            yield body;
        }
        const declared = Number(request.headers['x-amz-decoded-content-length']);
        if (!Number.isSafeInteger(declared) || decoded !== declared) throw new Error('IncompleteBody');
        if (pending.length || !(await iterator.next()).done) throw new Error('InvalidArgument');
    }
    return Readable.from(chunks());
}
module.exports = { verify, canonicalUri, canonicalQuery, signingKey, decodeAwsChunks, sha256 };
