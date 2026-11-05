'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { downloadFileName } = require('../server/download-file-name');

test('download names retain literal brackets, traceable authors, platform and resource IDs', () => {
    const samples = [
        ['x', 'https://x.com/jasdhv71/status/2116545205373673955', {}, '＠jasdhv71][X][2116545205373673955'],
        ['twitter', 'https://twitter.com/user/status/123', {}, '＠user][X][123'],
        ['youtube', 'https://youtu.be/67dqkyZXwd4?si=ignored', { authorHandle: '@creator' }, '＠creator][YT][67dqkyZXwd4'],
        ['bilibili', 'https://www.bilibili.com/video/BV1234', { uploaderId: '5566' }, '＠5566][Bili][BV1234'],
        ['netease', 'https://music.163.com/#/song?id=123', { uploaderId: 'artist' }, '＠artist][NEMusic][123'],
        ['facebook', 'https://www.facebook.com/watch/?v=678', { uploaderId: 'page' }, '＠page][FB][678'],
        ['line', 'https://line.me/post/123', { uploaderId: 'line-user' }, '＠line-user][LINE][123'],
        ['threads', 'https://www.threads.net/@creator/post/CODE', {}, '＠creator][Thr][CODE'],
        ['instagram', 'https://www.instagram.com/reel/CODE/', { uploaderId: 'creator' }, '＠creator][Ins][CODE'],
        ['tiktok', 'https://www.tiktok.com/@creator/video/123', {}, '＠creator][Tk][123']
    ];
    for (const [platform, url, referenceInfo, suffix] of samples) {
        assert.equal(downloadFileName({ platform, url, referenceInfo, title: 'Title', outputFileName: 'old.webm' }), `Title[${suffix}].webm`);
    }
});

test('cut start times are compact and optional, while the real output extension is preserved', () => {
    const task = { title: 'Title', url: 'https://youtu.be/video', outputFileName: 'actual.m4a' };
    const times = [['*01:25:03-02:36:07', '1h25m3'], ['3m7-5m9', '3m7'], ['3s-5m5', '3s'],
        ['*00:00:03-00:05:05', '3s'], ['*0-5', '0s'], ['*00:03.125-00:04', '3.125s']];
    for (const [downloadSections, expected] of times) {
        assert.equal(downloadFileName({ ...task, downloadSections }, 'youtube'), `Title [${expected}][YT][video].m4a`);
    }
    assert.equal(downloadFileName(task, 'youtube'), 'Title[YT][video].m4a');
});

test('legacy metadata and titles remain usable without unsafe characters or a fabricated author', () => {
    const task = { platform: 'x', url: 'https://x.com/i/status/123', title: 'A/B:C?\n', outputFileName: 'actual.mp4' };
    assert.equal(downloadFileName(task), 'A／B：C？[X][123].mp4');
    const long = downloadFileName({ ...task, title: '😀'.repeat(250), referenceInfo: { uploaderId: '@account', title: '😀'.repeat(250) } });
    assert.ok(long.length <= 240);
    assert.ok(!/[\ud800-\udbff]$/.test(long.slice(0, long.indexOf('[＠'))));
    assert.ok(long.endsWith('[＠account][X][123].mp4'));
});
