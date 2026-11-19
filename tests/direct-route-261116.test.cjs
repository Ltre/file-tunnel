'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createUpstreamExits } = require('../server/upstream-exits');
const { createSnsDownloadService, normalizeSnsDownloadUrl } = require('../server/sns-downloader');

async function completed(service, id) {
    const until = Date.now() + 3000;
    while (Date.now() < until) {
        const task = service.get(id);
        if (task.status === 'failed') throw Error(task.error);
        if (task.status === 'completed') return task;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw Error('Synthetic download did not complete');
}

for (const direct of [true, false]) {
    test((direct ? 'direct' : 'proxy') + ' format-ticket route is preserved in a completed SNS task and after restart', async t => {
        const prefix = 'direct-route-261116-';
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
        let starts = 0;
        const exits = createUpstreamExits({
            dataDir: dir, log() {},
            nativeFetch: async () => new Response('synthetic content'),
            startRuntime: async () => {
                starts++;
                return { proxy: 'http://127.0.0.1:50123', alive: () => true, stop() {} };
            }
        });
        t.after(async () => {
            await exits.close();
            const resolved = path.resolve(dir);
            assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
            assert.ok(path.basename(resolved).startsWith(prefix));
            fs.rmSync(resolved, { recursive: true, force: true });
        });
        const node = exits.saveNode(null, { name: 'HK-TOKYO', server: 'synthetic.invalid', port: 443, password: 'synthetic' });
        const exitId = direct ? 'direct' : node.id;
        const exitName = direct ? '本机直连' : 'HK-TOKYO';
        const url = normalizeSnsDownloadUrl(direct ? 'https://www.bilibili.com/video/BV1fixture' : 'https://x.com/fixture/status/123').url;
        exits.saveService(direct ? 'bilibili' : 'twitter', { revision: 0, defaultExit: exitId, mode: 'ordered', order: [], includeDirect: direct });
        const analysis = { id: 'media', title: 'Synthetic media', mediaType: 'video', formats: [{ id: '18' }], selection: { formatSelector: '18', ids: ['18'] } };
        const req = { body: { url } }, res = new EventEmitter();
        let parsed;
        res.json = value => { parsed = value; return res; };
        await exits.requestScope(req, res, async () => {
            const result = await exits.analyze(url, async () => {
                await (await exits.fetch(url)).text();
                return analysis;
            });
            res.json(result);
        });
        res.emit('finish');
        assert.equal(parsed.networkRoute.locked, true);
        assert.equal(parsed.networkRoute.selected.id, exitId);
        assert.equal(parsed.networkRoute.attempts.length, 1);

        let analyses = 0, downloads = 0;
        const options = {
            dataDir: dir,
            runTask: exits.runTask,
            analyze: async () => {
                analyses++;
                return exits.analyze(url, async () => analysis);
            },
            download: async ({ taskDir }) => {
                downloads++;
                await (await exits.fetch(url)).text();
                exits.observeCommand('[download] 100% of synthetic content');
                const outputPath = path.join(taskDir, 'media.mp4');
                fs.writeFileSync(outputPath, 'synthetic media');
                return { outputPath, outputFileName: 'media.mp4', outputFileSize: 15 };
            }
        };
        const service = createSnsDownloadService(options);
        const created = service.create({ url, mode: 'custom', selectedFormatIds: ['18'], networkTicket: parsed.networkTicket });
        const task = await completed(service, created.id);
        assert.equal(task.networkRoute?.selected?.name, exitName, 'inherited locked route must reach the task record');
        assert.equal(task.networkRoute.locked, true);
        assert.equal(task.networkRoute.attempts.length, 1, 'recording must not create another attempt or change the selected route');
        assert.equal(task.networkRoute.attempts[0].status, 'success');
        assert.equal(service.list().tasks[0].networkRoute.selected.id, exitId);
        const saved = JSON.parse(fs.readFileSync(path.join(dir, 'sns-download-tasks.json'), 'utf8'));
        assert.equal(saved[0].networkRoute.selected.id, exitId);
        const restored = createSnsDownloadService(options);
        assert.equal(restored.get(task.id).networkRoute.selected.name, exitName);
        assert.equal(analyses, 1);
        assert.equal(downloads, 1);
        assert.equal(starts, direct ? 0 : 1);
    });
}
