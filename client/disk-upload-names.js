(function (global) {
    'use strict';
    const folder = (file, destination) => String(file.diskFolderPath ?? destination ?? '').replace(/\\/g, '/').split('/').map(p => p.trim()).filter(p => p && p !== '.').join('/');
    function plan(files, destination) {
        const key = (path, name) => JSON.stringify([path, name]);
        const reserved = new Set(files.map(file => key(folder(file, destination), file.name.trim())));
        const seen = new Set(), changes = [];
        for (let index = 0; index < files.length; index++) {
            const file = files[index], path = folder(file, destination), normalized = file.name.trim(), original = key(path, normalized);
            if (!seen.has(original)) { seen.add(original); continue; }
            const dot = normalized.lastIndexOf('.'), hasExtension = dot > 0;
            const extension = hasExtension ? normalized.slice(dot) : '', stem = hasExtension ? normalized.slice(0, dot) : normalized;
            let sequence = 2, name;
            do {
                const suffix = ` (${sequence++})`;
                let head = stem.slice(0, Math.max(1, 180 - extension.length - suffix.length));
                if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
                name = head + suffix + extension;
                if (name.length > 180) throw new Error('文件扩展名过长，无法自动重命名：' + file.name);
            } while (reserved.has(key(path, name)));
            reserved.add(key(path, name)); changes.push({ index, path, originalName: file.name, name });
        }
        return changes;
    }
    async function prepare(files, destination, confirmRename) {
        const changes = plan(files, destination);
        if (!changes.length) return files;
        const detail = changes.slice(0, 8).map(item => `/${[item.path, item.originalName].filter(Boolean).join('/')} → ${item.name}`).join('\n');
        const accepted = await confirmRename(`本次上传中有 ${changes.length} 个文件与同一目标目录中的其它待上传文件重名。自动追加序号后上传？\n${detail}${changes.length > 8 ? '\n……' : ''}\n不会修改设备原文件；取消将停止整次上传。`);
        if (!accepted) return null;
        const names = new Map(changes.map(item => [item.index, item.name]));
        return files.map((file, index) => {
            if (!names.has(index)) return file;
            const copy = new File([file], names.get(index), { type: file.type, lastModified: file.lastModified });
            if (file.diskFolderPath !== undefined) copy.diskFolderPath = file.diskFolderPath;
            return copy;
        });
    }
    global.DiskUploadNames = { plan, prepare };
    if (typeof module === 'object') module.exports = global.DiskUploadNames;
})(typeof window === 'object' ? window : globalThis);
