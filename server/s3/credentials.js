'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const { readJson, writeJson, loadKey } = require('../disk-data');

const validBucket = value => /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value) && !value.includes('..');
function createS3Credentials(dataDir) {
    const file = path.join(dataDir, 's3-credentials.json');
    const key = loadKey(path.join(dataDir, 's3-secret.key'));
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
    function create({ userId, bucketMappings }) {
        if (!userId || !Array.isArray(bucketMappings) || !bucketMappings.length || bucketMappings.some(item => !validBucket(item.bucket) || typeof item.diskSpace !== 'string' || item.diskSpace.length > 100) || new Set(bucketMappings.map(item => item.bucket)).size !== bucketMappings.length)
            throw new Error('S3_CREDENTIAL_INPUT_INVALID');
        const data = read(), accessKeyId = `D2T${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
        const secretAccessKey = crypto.randomBytes(32).toString('base64url');
        const now = Date.now();
        data.credentials.push({ accessKeyId, encryptedSecret: seal(secretAccessKey), enabled: true, userId: String(userId), bucketMappings, createdAt: now, updatedAt: now });
        writeJson(file, data);
        return { accessKeyId, secretAccessKey, userId: String(userId), bucketMappings };
    }
    function disable(accessKeyId) {
        const data = read(), item = data.credentials.find(entry => entry.accessKeyId === accessKeyId);
        if (!item) throw new Error('S3_ACCESS_KEY_NOT_FOUND');
        item.enabled = false; item.updatedAt = Date.now(); writeJson(file, data);
    }
    function list() { return read().credentials.map(({ encryptedSecret, ...item }) => item); }
    return { find, create, disable, list };
}
module.exports = { createS3Credentials, validBucket };
