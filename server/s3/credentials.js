'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readJson, loadKey } = require('../disk-data');

const validBucket = value => typeof value === 'string' && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value)
    && !value.includes('..') && !/^\d{1,3}(\.\d{1,3}){3}$/.test(value)
    && !/^(xn--|sthree-|amzn-s3-demo-)/.test(value)
    && !/(-s3alias|--ol-s3|\.mrap|--x-s3|--table-s3|-an)$/.test(value);
function createS3Credentials(dataDir) {
    const file = path.join(dataDir, 's3-credentials.json');
    const keyFile = path.join(dataDir, 's3-secret.key');
    let key;
    try { key = loadKey(keyFile); }
    catch (error) { if (error.code !== 'EEXIST') throw error; key = fs.readFileSync(keyFile); }
    if (key.length !== 32) throw new Error('S3_SECRET_KEY_INVALID');
    const read = () => {
        const data = readJson(file, { version: 1, credentials: [] });
        if (data?.version !== 1 || !Array.isArray(data.credentials)) throw new Error('S3_CREDENTIALS_INVALID');
        return data;
    };
    function seal(secret) {
        const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        return Buffer.concat([iv, cipher.update(secret, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
    }
    function unseal(value) {
        const raw = Buffer.from(value, 'base64');
        if (raw.length < 29) throw new Error('S3_SECRET_INVALID');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
        decipher.setAuthTag(raw.subarray(-16));
        return Buffer.concat([decipher.update(raw.subarray(12, -16)), decipher.final()]).toString('utf8');
    }
    function find(accessKeyId) {
        const item = read().credentials.find(entry => entry.accessKeyId === accessKeyId);
        return item?.enabled ? { ...item, secretAccessKey: unseal(item.encryptedSecret) } : null;
    }
    const publicCredential = item => ({ accessKeyId: item.accessKeyId, enabled: item.enabled, userId: item.userId, managedBy: item.managedBy || 'admin',
        remark: item.remark || '', bucketMappings: item.bucketMappings, createdAt: item.createdAt, updatedAt: item.updatedAt });
    const userBucket = (userId, diskSpace) => `userbucket-${userId.toLowerCase()}${diskSpace ? '-' + crypto.createHash('sha256').update(diskSpace).digest('hex').slice(0, 12) : ''}`;
    const userMapping = (item, userId, diskSpace) => item.userId === userId && item.bucketMappings?.some(mapping => mapping.diskSpace === diskSpace);
    function userSpace(userId, diskSpace) {
        const item = read().credentials.find(entry => entry.managedBy === 'owner-ui' && userMapping(entry, userId, diskSpace));
        return item ? publicCredential(item) : null;
    }
    function enableUserSpace(userId, diskSpace) {
        if (!/^[a-f0-9-]{36}$/i.test(userId) || typeof diskSpace !== 'string' || diskSpace.length > 100) throw new Error('S3_CREDENTIAL_INPUT_INVALID');
        return mutate(data => {
            const existing = data.credentials.filter(item => userMapping(item, userId, diskSpace));
            if (existing.some(item => item.managedBy !== 'owner-ui') || existing.length > 1) throw new Error('S3_SPACE_ALREADY_MAPPED');
            if (existing.length) {
                const item = existing[0];
                if (item.enabled) return publicCredential(item);
                item.enabled = true;
                const secretAccessKey = crypto.randomBytes(32).toString('base64url');
                item.encryptedSecret = seal(secretAccessKey); item.updatedAt = Math.max(Date.now(), item.updatedAt + 1);
                return { ...publicCredential(item), secretAccessKey };
            }
            const bucket = userBucket(userId, diskSpace);
            if (!validBucket(bucket) || data.credentials.some(item => item.bucketMappings?.some(mapping => mapping.bucket === bucket))) throw new Error('S3_SPACE_ALREADY_MAPPED');
            let accessKeyId;
            do { accessKeyId = `D2T${crypto.randomBytes(12).toString('hex').toUpperCase()}`; } while (data.credentials.some(item => item.accessKeyId === accessKeyId));
            const secretAccessKey = crypto.randomBytes(32).toString('base64url'), now = Date.now();
            const item = { accessKeyId, encryptedSecret: seal(secretAccessKey), userId, managedBy: 'owner-ui', enabled: true,
                remark: `用户分区 · ${diskSpace || '默认分区'}`, bucketMappings: [{ bucket, diskSpace }], createdAt: now, updatedAt: now };
            data.credentials.push(item);
            return { ...publicCredential(item), secretAccessKey };
        });
    }
    function rotateUserSpace(userId, diskSpace) {
        return mutate(data => {
            const item = data.credentials.find(entry => entry.managedBy === 'owner-ui' && userMapping(entry, userId, diskSpace) && entry.enabled);
            if (!item) throw new Error('S3_ACCESS_KEY_NOT_FOUND');
            const secretAccessKey = crypto.randomBytes(32).toString('base64url');
            item.encryptedSecret = seal(secretAccessKey); item.updatedAt = Math.max(Date.now(), item.updatedAt + 1);
            return { ...publicCredential(item), secretAccessKey };
        });
    }
    function disableUserSpace(userId, diskSpace) {
        return mutate(data => {
            const item = data.credentials.find(entry => entry.managedBy === 'owner-ui' && userMapping(entry, userId, diskSpace));
            if (!item) throw new Error('S3_ACCESS_KEY_NOT_FOUND');
            item.enabled = false; item.updatedAt = Math.max(Date.now(), item.updatedAt + 1);
            return publicCredential(item);
        });
    }
    function retireUserSpace(userId, diskSpace) {
        return mutate(data => {
            let changed = 0;
            for (const item of data.credentials) {
                if (item.userId !== userId || !item.bucketMappings?.some(mapping => mapping.diskSpace === diskSpace)) continue;
                if (item.bucketMappings.length === 1) item.enabled = false;
                else item.bucketMappings = item.bucketMappings.filter(mapping => mapping.diskSpace !== diskSpace);
                item.updatedAt = Math.max(Date.now(), Number(item.updatedAt) + 1);
                changed++;
            }
            return changed;
        });
    }
    function validate({ userId, bucketMappings, remark = '', enabled = true }) {
        if (typeof userId !== 'string' || !userId || userId.length > 100 || typeof remark !== 'string' || remark.length > 160 || /[\u0000-\u001f\u007f]/.test(remark) || typeof enabled !== 'boolean'
            || !Array.isArray(bucketMappings) || !bucketMappings.length || bucketMappings.length > 100
            || bucketMappings.some(item => !item || typeof item.bucket !== 'string' || !validBucket(item.bucket) || typeof item.diskSpace !== 'string' || item.diskSpace.length > 100 || /[\u0000-\u001f\u007f]/.test(item.diskSpace)
                || item.backendId !== undefined && (typeof item.backendId !== 'string' || item.backendId.length > 100))
            || new Set(bucketMappings.map(item => item.bucket)).size !== bucketMappings.length)
            throw new Error('S3_CREDENTIAL_INPUT_INVALID');
        return { userId, remark: remark.trim(), enabled, bucketMappings: bucketMappings.map(item => ({ bucket: item.bucket, diskSpace: item.diskSpace, ...(item.backendId ? { backendId: item.backendId } : {}) })) };
    }
    function mutate(work) {
        // Synchronous mutations serialize the event loop. The exclusive lock
        // additionally protects against a CLI or a second Node process writing.
        const lockFile = file + '.lock';
        let lock;
        try { lock = fs.openSync(lockFile, 'wx', 0o600); }
        catch (error) { if (error.code === 'EEXIST') throw new Error('S3_CREDENTIALS_BUSY'); throw error; }
        const temp = file + '.' + crypto.randomUUID() + '.tmp';
        try {
            fs.writeFileSync(lock, String(process.pid));
            const data = read(), result = work(data);
            fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
            fs.renameSync(temp, file);
            return result;
        } finally {
            try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            finally { try { fs.closeSync(lock); } finally { fs.unlinkSync(lockFile); } }
        }
    }
    function selected(data, accessKeyId, expectedUpdatedAt) {
        const item = data.credentials.find(entry => entry.accessKeyId === accessKeyId);
        if (!item) throw new Error('S3_ACCESS_KEY_NOT_FOUND');
        if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== item.updatedAt) throw new Error('S3_CREDENTIAL_CONFLICT');
        return item;
    }
    function create(input) {
        const fields = validate(input);
        return mutate(data => {
            let accessKeyId;
            do { accessKeyId = `D2T${crypto.randomBytes(12).toString('hex').toUpperCase()}`; } while (data.credentials.some(item => item.accessKeyId === accessKeyId));
            const secretAccessKey = crypto.randomBytes(32).toString('base64url'), now = Date.now();
            const item = { ...fields, accessKeyId, encryptedSecret: seal(secretAccessKey), createdAt: now, updatedAt: now };
            data.credentials.push(item);
            return { ...publicCredential(item), secretAccessKey };
        });
    }
    function update(accessKeyId, changes, { expectedUpdatedAt } = {}) {
        return mutate(data => {
            const item = selected(data, accessKeyId, expectedUpdatedAt);
            // A retired user, partition or legacy Bucket name must never make
            // disabling a credential impossible.
            const disabling = changes?.enabled === false && Object.keys(changes).every(name => name === 'enabled');
            const fields = disabling ? { enabled: false } : validate({ ...item, ...changes });
            Object.assign(item, fields, { updatedAt: Math.max(Date.now(), Number(item.updatedAt) + 1) });
            return publicCredential(item);
        });
    }
    function rotate(accessKeyId, { expectedUpdatedAt } = {}) {
        return mutate(data => {
            const item = selected(data, accessKeyId, expectedUpdatedAt), secretAccessKey = crypto.randomBytes(32).toString('base64url');
            item.encryptedSecret = seal(secretAccessKey);
            item.updatedAt = Math.max(Date.now(), Number(item.updatedAt) + 1);
            return { ...publicCredential(item), secretAccessKey };
        });
    }
    function disable(accessKeyId) { return update(accessKeyId, { enabled: false }); }
    function list() { return read().credentials.map(publicCredential); }
    return { find, create, update, rotate, disable, list, userSpace, enableUserSpace, rotateUserSpace, disableUserSpace, retireUserSpace, userBucket };
}
module.exports = { createS3Credentials, validBucket };
