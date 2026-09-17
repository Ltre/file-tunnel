'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const { defaultProfiles, validateParams, buildArgs, createVideoTranscodeService } = require('../server/video-transcode');

function workshopTools() {
    const window = {};
    vm.runInNewContext(source('client/web-workshop.js'), { window, Uint8Array, TextEncoder, TextDecoder, Blob, File:globalThis.File, Map, Set, Date, Math, String, Number, Object, Array, RegExp, Error, Promise, URL, setTimeout, clearTimeout });
    return window.WebWorkshop._test;
}

test('网页工坊统一校验名称冲突、目录循环并按每层目录优先排序', () => {
    const tools = workshopTools();
    const entries = tools.normalizeEntries([
        { path:'z.txt', data:new Uint8Array() },
        { path:'docs/readme.md', data:new Uint8Array() },
        { path:'assets/', type:'application/x-directory', data:new Uint8Array() }
    ], { allowIdenticalDirectory:true });
    assert.deepEqual(Array.from(tools.sortedChildren(entries, ''), item => item.path), ['assets/','docs/','z.txt']);
    assert.throws(() => tools.normalizeEntries([{path:'same',data:new Uint8Array()},{path:'same/',type:'application/x-directory',data:new Uint8Array()}]), /同名项目/);
    assert.throws(() => tools.assertDestination(entries, 'docs/', 'docs/child/'), /自己或自己的子目录|目标目录不存在/);
    const edited = '<main>这是切换文件和拖动前已经完成的一整段修改</main>';
    tools.updateTextEntry(entries, 'z.txt', edited);
    const moved = tools.assertDestination(entries, 'z.txt', 'docs/');
    assert.equal(moved.nextPath, 'docs/z.txt');
    assert.ok(moved.entries.some(item => item.path === 'docs/z.txt'));
    assert.equal(new TextDecoder().decode(moved.entries.find(item => item.path === 'docs/z.txt').data), edited);
    assert.throws(() => tools.renameEntry(moved.entries, 'docs/z.txt', 'readme.md'), /同名项目/);
    assert.match(source('client/web-workshop.js'), /commitEditorBuffer\(draft\);const result=assertDestination/);
    assert.match(source('client/web-workshop.js'), /有未保存修改/);
    assert.match(source('client/web-workshop.js'), /data-editor-action="save">保存/);
    assert.match(source('client/web-workshop.js'), /event\.ctrlKey\|\|event\.metaKey/);
    assert.match(source('client/web-workshop.css'), /web-workshop-save-status/);
});

test('内置 H.265 方案默认 CRF 28，编码速度留空时不生成 preset 且复制音轨', () => {
    for (const profile of defaultProfiles()) {
        assert.equal(profile.fields.find(field => field.name === 'CRF').default, '28');
        assert.equal(profile.fields.find(field => field.name === 'PRESET').default, '');
        const values = validateParams(profile, {});
        const args = buildArgs(profile.steps[0], { ...values, INPUT_FILE:'input.mp4', OUTPUT_FILE:'output.mp4' });
        assert.equal(args.includes('-preset'), false);
        assert.deepEqual(args.slice(args.indexOf('-c:a'), args.indexOf('-c:a') + 2), ['-c:a','copy']);
    }
});

test('视频转码缓存统计不会删除执行中目录，并区分残留与已结束缓存', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-cache-'));
    try {
        const service = createVideoTranscodeService({ dataDir });
        const task = service.createTask({ profileId:'h265-balanced', params:{}, fileName:'demo.mp4', size:1 });
        fs.writeFileSync(path.join(dataDir, '.video-transcode', task.id, 'part.tmp'), 'a');
        const orphan = path.join(dataDir, '.video-transcode', 'orphan'); fs.mkdirSync(orphan); fs.writeFileSync(path.join(orphan, 'x'), 'orphan');
        const result = service.cleanupCache('residual');
        assert.equal(fs.existsSync(path.join(dataDir, '.video-transcode', task.id)), true);
        assert.equal(fs.existsSync(orphan), false);
        assert.ok(result.removedBytes >= 6);
    } finally { fs.rmSync(dataDir, { recursive:true, force:true }); }
});

test('独立网页 ZIP 路由、编辑权限卡片、版本替换和转码帮助均已接入', () => {
    const app = source('app.js'), server = source('server.js'), page = source('pages/index.html'), diskCss = source('client/disk.css'), transcode = source('pages/video-transcode.html');
    assert.match(app, /openWebZipStandalone/);
    assert.match(app, /编辑此网页/);
    assert.match(app, /replacesFileId/);
    assert.match(app, /\['workshop', '🌐', '网页工坊'/);
    assert.match(server, /\/web-zip-preview\/:fileId/);
    assert.match(server, /file\?\.replacesFileId === previousFile\.id/);
    assert.match(page, /sessionLanding[\s\S]*Drop2Tunnel[\s\S]*id="appShell"/);
    assert.doesNotMatch(page.match(/<div class="container" id="appShell"[\s\S]*?<div class="main-layout">/)?.[0] || '', /Drop2Tunnel/);
    assert.match(diskCss, /#telegramDriveItemMenu\{position:fixed!important;right:auto!important/);
    assert.match(transcode, /video-transcode-guide\.html/);
    assert.match(transcode, /openLogTasks/);
    assert.match(source('pages/video-transcode-guide.html'), /从提交到执行的完整流程/);
});
