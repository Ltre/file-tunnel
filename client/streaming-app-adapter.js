(function (global) {
    'use strict';
    // Composition only: consumers read the existing local cache; this module
    // neither changes transfer scheduling nor creates/join tunnels.
    function create(deps) {
        const deviceId = () => localStorage.getItem('deviceId') || deps.state.deviceId;
        async function tunnels() {
            const entries = await deps.listSessions();
            if (deps.state.sessionId) {
                const current = entries.find(entry => entry.sessionId === deps.state.sessionId);
                if (current) { current.shortCode = deps.state.shortCode || current.shortCode; current.remark = deps.state.sessionRemark || current.remark; }
                else entries.push({ sessionId: deps.state.sessionId, shortCode: deps.state.shortCode, remark: deps.state.sessionRemark });
            }
            return entries.map(entry => ({ sessionId: entry.sessionId, shortCode: entry.shortCode || '', remark: entry.remark || '', name: [entry.shortCode, entry.remark].filter(Boolean).join(' · ') || entry.sessionId,
                accessGrant: deps.authorization(entry.sessionId).grant, tunnelDeviceId: deps.authorization(entry.sessionId).deviceId }))
                .filter(entry => entry.accessGrant);
        }
        async function readTunnel(source, { start = 0, end } = {}) {
            if (source.fileId === 'record') {
                const message = await deps.message(source.messageId);
                if (!message || message.sessionId !== source.sessionId) throw Error('missing');
                return new Blob([message.type === 'markdown' ? message.markdown : message.text || ''], { type: message.type === 'markdown' ? 'text/markdown' : 'text/plain' }).slice(start, end === undefined ? undefined : end + 1);
            }
            let file = await deps.file(source.fileId);
            if (file?.externalFileHandle) file = await deps.materialize(file);
            if (file && deps.complete(file, file) && file.data) {
                const blob = file.data instanceof Blob ? file.data : new Blob([file.data], { type: file.type || 'application/octet-stream' });
                return blob.slice(start, end === undefined ? undefined : end + 1);
            }
            // Consume the existing server-asset Range endpoint. No P2P request,
            // cache backfill, retention or transfer scheduling is introduced.
            const message = await deps.message(source.messageId);
            if (!message || message.sessionId !== source.sessionId) throw Error('missing');
            const original = message.type === 'file' ? message.fileInfo : message.collection?.files?.find(item => item.id === source.fileId);
            if (original?.id !== source.fileId || !/^\/api\/server-assets\/[\w-]+$/.test(original.serverAssetUrl || '') || end === undefined) throw Error('missing');
            const response = await fetch(original.serverAssetUrl, { headers: { Range: 'bytes=' + start + '-' + end }, cache: 'no-store' });
            if (response.status === 404) throw Error('missing');
            if (response.status !== 206 || response.headers.get('Content-Range') !== 'bytes ' + start + '-' + end + '/' + original.size) { await response.body?.cancel(); throw Error('unavailable'); }
            return response.blob();
        }
        function devices() {
            const known = new Map();
            for (const [id, device] of deps.state.devices) known.set(device.deviceId || id, { ...device, deviceId: device.deviceId || id, name: device.deviceName || device.name || id });
            for (const [id, device] of deps.state.contacts) known.set(device.deviceId || id, { ...known.get(device.deviceId || id), ...device, deviceId: device.deviceId || id, name: device.remark || device.deviceName || device.name || id, followed: true });
            return [...known.values()];
        }
        const referenceNames = new Map();
        async function readReference(value, { maxBytes = 256 * 1024 * 1024 } = {}) {
            await global.StreamingConsole.whenReady();
            const match = /^tunnel-blob:([\w-]+)\/([\w.-]+)\/([\w.-]+)$/.exec(value);
            if (!match) throw Error('STREAM_REFERENCE_INVALID');
            const entry = (await tunnels()).find(entry => entry.sessionId === match[1]);
            if (!entry) throw Error('STREAM_TUNNEL_DENIED');
            const result = await global.StreamingConsole.request('/tunnel-resources', 'POST', entry);
            const candidate = result.candidates.find(item => item.source.messageId === match[2] && item.source.fileId === match[3]);
            if (!candidate) throw Error('STREAM_SOURCE_DELETED');
            referenceNames.set(value, candidate.name.replace(/[\\/:*?"<>|]/g, '_'));
            const ticket = await global.StreamingConsole.request('/blob-preview', 'POST', { source: candidate.source });
            const response = await fetch(ticket.url, { cache: 'no-store' }); if (!response.ok) throw Error('STREAM_REFERENCE_UNAVAILABLE');
            if (Number(response.headers.get('Content-Length')) > maxBytes) { await response.body?.cancel(); throw Error('STREAM_REFERENCE_LIMIT'); }
            return response.blob();
        }
        global.TunnelMarkdown.init({ readReference, record: deps.message, edit: deps.editMarkdown,
            referenceName: value => referenceNames.get(value) || value.split('/').at(-1),
            upload: async file => {
                const user = await global.DiskUI.chooseAccount();
                if (!user) throw Error('STREAM_SAVE_CANCELLED');
                const selected = await global.DiskUI.chooseSaveDestination?.({ userId: user.id });
                if (!selected) throw Error('STREAM_SAVE_CANCELLED');
                await global.DiskClient.upload([file], selected.path ?? '', undefined, { transportContext: selected.transportContext || selected.context || global.DiskClient.context() });
            } });
        return { deviceId, deviceName: () => deps.state.deviceName || deviceId(), tunnels, devices, readTunnel,
            currentTunnel: () => deps.state.sessionId, home: deps.home, toast: deps.toast, onMessage: deps.receiveMessage };
    }
    global.StreamingAppAdapter = { create };
})(window);
