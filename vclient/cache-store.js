'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const INDEX_VERSION = 1;

function safeSegment(value, fallback = 'unknown') {
    const safe = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    return safe || fallback;
}

function sessionDirectoryName(sessionId) {
    return crypto.createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 20);
}

function normalizeAsset(asset) {
    if (!asset || typeof asset !== 'object') return null;
    const id = asset.id || asset.file_id;
    const name = asset.name || asset.file_name;
    const size = Number(asset.size ?? asset.declared_size);
    if (!id || !name || !Number.isSafeInteger(size) || size <= 0) return null;
    return {
        id: String(id).slice(0, 80),
        name: String(name).slice(0, 255),
        type: String(asset.type || asset.mime_type || '').slice(0, 100),
        size,
        assetKind: String(asset.assetKind || asset.asset_kind || '').toLowerCase() === 'editor'
            ? 'editor'
            : 'file',
        ownerDeviceId: asset.ownerDeviceId ? String(asset.ownerDeviceId).slice(0, 80) : undefined,
        isFolderArchive: asset.isFolderArchive === true,
        isDirectoryMirror: asset.isDirectoryMirror === true,
        folderName: asset.folderName ? String(asset.folderName).slice(0, 120) : undefined,
        entryCount: Number.isInteger(asset.entryCount) ? asset.entryCount : undefined,
        sha256: /^[a-f0-9]{64}$/i.test(String(asset.sha256 || '')) ? String(asset.sha256).toLowerCase() : undefined
    };
}

class CacheStore {
    constructor(rootDir, options = {}) {
        if (!rootDir) throw new Error('VClient cache root is required');
        this.rootDir = path.resolve(rootDir);
        this.assetsDir = path.join(this.rootDir, 'assets');
        this.partialDir = path.join(this.rootDir, 'partials');
        this.indexPath = path.join(this.rootDir, 'cache-index.json');
        this.instancePath = path.join(this.rootDir, 'instance.json');
        this.fs = options.fs || fs.promises;
        this.index = { version: INDEX_VERSION, assets: {} };
        this.instanceId = '';
        this.initialized = false;
        this.saveChain = Promise.resolve();
        this.verificationCache = new Map();
    }

    async init() {
        if (this.initialized) return this;
        await this.fs.mkdir(this.assetsDir, { recursive: true });
        await this.fs.mkdir(this.partialDir, { recursive: true });
        this.index = await this._readJson(this.indexPath, { version: INDEX_VERSION, assets: {} });
        if (!this.index || this.index.version !== INDEX_VERSION || typeof this.index.assets !== 'object') {
            this.index = { version: INDEX_VERSION, assets: {} };
        }
        const instance = await this._readJson(this.instancePath, null);
        this.instanceId = instance && typeof instance.instanceId === 'string' && instance.instanceId
            ? instance.instanceId
            : crypto.randomUUID();
        if (!instance || instance.instanceId !== this.instanceId) {
            await this._writeJsonAtomic(this.instancePath, { instanceId: this.instanceId, createdAt: Date.now() });
        }
        this.initialized = true;
        return this;
    }

    async _readJson(filePath, fallback) {
        try {
            return JSON.parse(await this.fs.readFile(filePath, 'utf8'));
        } catch (err) {
            if (err && err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
            return fallback;
        }
    }

    async _writeJsonAtomic(filePath, value) {
        const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        await this.fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
        await this.fs.rename(temporary, filePath);
    }

    _key(sessionId, assetId) {
        return `${String(sessionId)}\u0000${String(assetId)}`;
    }

    stableDeviceId(sessionId) {
        if (!this.instanceId) throw new Error('CacheStore must be initialized first');
        const bytes = crypto.createHash('sha256')
            .update(this.instanceId)
            .update('\u0000')
            .update(String(sessionId))
            .digest()
            .subarray(0, 16);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = bytes.toString('hex');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    async createPartialPath(sessionId, assetId) {
        await this.init();
        const directory = path.join(this.partialDir, sessionDirectoryName(sessionId));
        await this.fs.mkdir(directory, { recursive: true });
        return path.join(directory, `${safeSegment(assetId)}-${crypto.randomBytes(8).toString('hex')}.part`);
    }

    async commitTemp(sessionId, asset, temporaryPath, details = {}) {
        await this.init();
        const metadata = normalizeAsset(asset);
        if (!metadata) throw new Error('Invalid asset metadata');
        const sha256 = String(details.sha256 || '').toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid SHA-256 digest');
        if (metadata.sha256 && metadata.sha256 !== sha256) throw new Error('File asset SHA-256 mismatch');
        const receivedSize = Number(details.size);
        if (receivedSize !== metadata.size) throw new Error('File asset size mismatch');
        const temporaryStat = await this.fs.stat(temporaryPath);
        if (!temporaryStat.isFile() || temporaryStat.size !== metadata.size) throw new Error('Temporary file size mismatch');

        const directoryName = sessionDirectoryName(sessionId);
        const directory = path.join(this.assetsDir, directoryName);
        await this.fs.mkdir(directory, { recursive: true });
        const relativePath = path.join('assets', directoryName, `${safeSegment(metadata.id)}-${sha256}.bin`);
        const finalPath = path.join(this.rootDir, relativePath);
        try {
            await this.fs.rename(temporaryPath, finalPath);
        } catch (err) {
            if (err?.code !== 'EEXIST' && err?.code !== 'EPERM') throw err;
            const existing = await this.fs.stat(finalPath).catch(() => null);
            if (!existing || existing.size !== metadata.size) throw err;
            await this.fs.unlink(temporaryPath).catch(() => {});
        }

        const record = {
            sessionId: String(sessionId),
            asset: { ...metadata, sha256 },
            relativePath,
            sha256,
            size: metadata.size,
            cachedAt: Date.now()
        };
        this.index.assets[this._key(sessionId, metadata.id)] = record;
        await this._saveIndex();
        return { ...record, path: finalPath };
    }

    async _saveIndex() {
        this.saveChain = this.saveChain
            .catch(() => {})
            .then(() => this._writeJsonAtomic(this.indexPath, this.index));
        return this.saveChain;
    }

    async getCached(sessionId, assetId, expectedAsset = null) {
        await this.init();
        const record = this.index.assets[this._key(sessionId, assetId)];
        if (!record || !record.relativePath) return null;
        const absolutePath = path.resolve(this.rootDir, record.relativePath);
        const rootPrefix = `${this.rootDir}${path.sep}`;
        if (!absolutePath.startsWith(rootPrefix)) return null;
        const stat = await this.fs.stat(absolutePath).catch(() => null);
        if (!stat?.isFile() || stat.size !== Number(record.size)) return null;
        if (expectedAsset && Number(expectedAsset.size) !== stat.size) return null;
        const expectedSha256 = String(record.sha256 || record.asset?.sha256 || '').toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
            await this._quarantineInvalid(sessionId, assetId, absolutePath, 'missing-sha256');
            return null;
        }
        const verificationKey = `${absolutePath}\u0000${stat.size}\u0000${Number(stat.mtimeMs) || 0}\u0000${expectedSha256}`;
        if (!this.verificationCache.has(verificationKey)) {
            const actualSha256 = await this._sha256File(absolutePath);
            if (actualSha256 !== expectedSha256) {
                await this._quarantineInvalid(sessionId, assetId, absolutePath, 'sha256-mismatch');
                return null;
            }
            this.verificationCache.set(verificationKey, true);
        }
        return { ...record, path: absolutePath };
    }

    async _sha256File(filePath) {
        const hash = crypto.createHash('sha256');
        await new Promise((resolve, reject) => {
            const stream = fs.createReadStream(filePath);
            stream.on('data', chunk => hash.update(chunk));
            stream.on('error', reject);
            stream.on('end', resolve);
        });
        return hash.digest('hex');
    }

    async _quarantineInvalid(sessionId, assetId, absolutePath, reason) {
        const key = this._key(sessionId, assetId);
        const record = this.index.assets[key];
        if (!record) return;
        const quarantinePath = `${absolutePath}.corrupt-${Date.now()}-${safeSegment(reason, 'invalid')}`;
        await this.fs.rename(absolutePath, quarantinePath).catch(() => {});
        delete this.index.assets[key];
        this.verificationCache.clear();
        await this._saveIndex();
    }

    async listSessionAssets(sessionId) {
        await this.init();
        const matches = Object.values(this.index.assets).filter(item => item?.sessionId === String(sessionId));
        const existing = [];
        for (const item of matches) {
            const cached = await this.getCached(sessionId, item.asset?.id, item.asset);
            if (cached) existing.push(cached);
        }
        return existing;
    }

    sessionTotals(sessionId) {
        const records = Object.values(this.index.assets).filter(item => item?.sessionId === String(sessionId));
        return {
            files: records.length,
            bytes: records.reduce((total, item) => total + (Number(item?.size) || 0), 0)
        };
    }
}

module.exports = {
    CacheStore,
    normalizeAsset,
    safeSegment,
    sessionDirectoryName
};
