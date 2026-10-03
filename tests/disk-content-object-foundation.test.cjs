'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDiskRepository } = require('../server/disk-repository');
const { createDiskContentStore, manifestSha256 } = require('../server/disk-content-store');

test('schema v2 可持久化全局 Content Object 与独立 physical parts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop2-content-'));
    try {
        const store = createDiskContentStore({ dataDir:dir });
        const content = {
            id:'content-1', contentSha256:'', manifestSha256:'m', size:30, originalName:'a.bin',
            originalMimeType:'application/octet-stream', physicalRevision:1, state:'READY',
            parts:[
                { partIndex:1, partCount:2, offset:0, size:20, sha256:'a'.repeat(64), fileId:'F1', messageId:1 },
                { partIndex:2, partCount:2, offset:20, size:10, sha256:'b'.repeat(64), fileId:'F2', messageId:2 }
            ]
        };
        store.put(content);
        assert.deepEqual(store.get('content-1').parts.map(part => part.fileId), ['F1','F2']);
        openDiskRepository(dir).assertIntegrity();
    } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});

test('legacy Logical File 可解析为兼容 Content view', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop2-content-'));
    try {
        const store = createDiskContentStore({ dataDir:dir });
        const file = { id:'logical-1', name:'x.bin', type:'application/octet-stream', size:3, channelId:'-1001',
            parts:[{ partIndex:1, partCount:1, offset:0, size:3, sha256:'c'.repeat(64), fileId:'F', messageId:9 }] };
        const resolved = store.resolve(file);
        assert.equal(resolved.id, 'legacy:logical-1');
        assert.equal(resolved.state, 'LEGACY');
        assert.equal(resolved.parts[0].fileId, 'F');
    } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});

test('manifest identity只由 size 和分片 size/sha256 决定', () => {
    const parts = [{ partIndex:1, size:3, sha256:'d'.repeat(64) }];
    assert.equal(
        manifestSha256({ name:'a', type:'x/a', size:3, parts }),
        manifestSha256({ name:'b', type:'x/b', size:3, parts })
    );
});


test('schema v3 修复早期 v2 content_parts 外键结构', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop2-content-v2-'));
    try {
        const { DatabaseSync } = require('node:sqlite');
        fs.mkdirSync(dir, { recursive:true });
        const filename = path.join(dir, 'disk.sqlite');
        const db = new DatabaseSync(filename);
        db.exec(`
            PRAGMA foreign_keys = OFF;
            CREATE TABLE disk_schema_migrations(version INTEGER PRIMARY KEY);
            INSERT INTO disk_schema_migrations(version) VALUES (1),(2);
            CREATE TABLE disk_contents(
                scope TEXT NOT NULL DEFAULT '', id TEXT NOT NULL,
                owner_id TEXT NOT NULL DEFAULT '', folder_path TEXT NOT NULL DEFAULT '',
                name TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL,
                PRIMARY KEY(scope,id)
            );
            INSERT INTO disk_contents(scope,id,payload) VALUES ('','c1','{"id":"c1","size":1}');
            CREATE TABLE disk_content_parts(
                content_id TEXT NOT NULL, part_index INTEGER NOT NULL,
                payload TEXT NOT NULL, PRIMARY KEY(content_id,part_index)
            );
            INSERT INTO disk_content_parts(content_id,part_index,payload) VALUES ('c1',0,'{"fileId":"F"}');
        `);
        db.close();
        const repository = openDiskRepository(dir);
        assert.equal(repository.load('contents')[0].parts[0].fileId, 'F');
        repository.assertIntegrity();
    } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});
