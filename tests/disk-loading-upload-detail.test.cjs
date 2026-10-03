'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ui = fs.readFileSync(path.join(__dirname, '../client/disk-ui.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../client/disk.css'), 'utf8');

test('网盘居中 Loading 上传明细保持多行结构、缩进和最终组状态', () => {
    assert.match(ui, /lines = \[\`目录：\$\{telegramDriveDisplayPath\(job\.folderPath \|\| ''\)\}\`, ''\]/);
    assert.match(ui, /浏览器 → 服务器 ·/);
    assert.match(ui, /服务器 → Telegram ·/);
    assert.match(ui, /  - 正在上传第\$\{clientPartIndex\}个分片，共\$\{clientPartCount\}个/);
    assert.match(ui, /  - 正在上传第\$\{fileIndex\}个文件 ·/);
    assert.match(ui, /  - 正在推送第\$\{partIndex\}个分片，共\$\{partCount\}个/);
    assert.match(ui, /    - 正在推送第\$\{partIndex\}个分片到TG/);
    assert.match(ui, /    - 第\$\{partIndex\}个分片推送已确认/);
    assert.match(ui, /  - 正在提交最终媒体组 · \$\{Math\.max\(1, groupIndex\)\}\/\$\{groupTotal\}/);
    assert.match(ui, /detail:lines\.join\('\\n'\)/);
    assert.match(css, /#diskLoadingDetail\{[^}]*white-space:pre-wrap[^}]*text-align:left/);
});

test('上传 Loading 不再使用旧 stages 单行拼接，也不显示独立 confirmed-byte 行', () => {
    const start = ui.indexOf('function formatDiskUploadLoading(job)');
    const end = ui.indexOf('function initDiskLoading()', start);
    const formatter = ui.slice(start, end);
    assert.ok(start >= 0 && end > start);
    assert.doesNotMatch(formatter, /stages\.join\(' · '\)/);
    assert.doesNotMatch(formatter, /Telegram 已确认 \$\{formatFileSize/);
    assert.match(formatter, /telegramPartConfirmed/);
    assert.match(formatter, /telegramFinalGroupsTotal/);
});
