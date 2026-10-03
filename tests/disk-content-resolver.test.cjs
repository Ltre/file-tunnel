'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const api = fs.readFileSync(path.join(__dirname, '../server/disk-api.js'), 'utf8');

test('check/download/stream 通过 Content resolver 获取 physical parts', () => {
    assert.match(api, /const physicalFile = \(req, file\) =>/);
    assert.match(api, /store\(req\)\.resolveContent\?\.\(owner\(req\), file\.id\)/);
    assert.match(api, /telegram\.check\(fileBackend\(req, physical\), physical\)/);
    assert.match(api, /prepareRemoteResponse\(req, res, fileBackend\(req, physical\), physical, \{ operationId: id \}\)/);
    assert.match(api, /prepareRemoteResponse\(req, res, fileBackend\(req, physical\), physical, \{ inline: true \}\)/);
});

test('旧文件仍保留 legacy fallback', () => {
    assert.match(api, /content\.state === 'LEGACY'/);
    assert.match(api, /content\.durable === false/);
    assert.match(api, /return file;/);
});
