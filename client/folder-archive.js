(function (global) {
    const encoder = new TextEncoder();
    const crcTable = (() => {
        const table = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let value = i;
            for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
            table[i] = value >>> 0;
        }
        return table;
    })();

    function crc32(bytes) {
        let value = 0xffffffff;
        for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff];
        return (value ^ 0xffffffff) >>> 0;
    }

    function writeUint16(view, offset, value) {
        view.setUint16(offset, value, true);
    }

    function writeUint32(view, offset, value) {
        view.setUint32(offset, value, true);
    }

    function normalizePath(file) {
        const path = (file.path || file.webkitRelativePath || file.name || 'file').replace(/\\/g, '/');
        return path.split('/').filter(part => part && part !== '.' && part !== '..').join('/');
    }

    async function createZip(files) {
        const entries = [];
        let offset = 0;
        for (const file of files) {
            const pathBytes = encoder.encode(normalizePath(file));
            const data = new Uint8Array(await file.arrayBuffer());
            const crc = crc32(data);
            const local = new Uint8Array(30 + pathBytes.length + data.length);
            const view = new DataView(local.buffer);
            writeUint32(view, 0, 0x04034b50);
            writeUint16(view, 4, 20);
            writeUint16(view, 6, 0x0800);
            writeUint16(view, 8, 0);
            writeUint16(view, 10, 0);
            writeUint16(view, 12, 0);
            writeUint32(view, 14, crc);
            writeUint32(view, 18, data.length);
            writeUint32(view, 22, data.length);
            writeUint16(view, 26, pathBytes.length);
            writeUint16(view, 28, 0);
            local.set(pathBytes, 30);
            local.set(data, 30 + pathBytes.length);
            entries.push({ pathBytes, data, crc, offset, local });
            offset += local.length;
        }

        const centralSize = entries.reduce((size, entry) => size + 46 + entry.pathBytes.length, 0);
        const output = new Uint8Array(offset + centralSize + 22);
        let cursor = 0;
        entries.forEach(entry => {
            output.set(entry.local, cursor);
            cursor += entry.local.length;
        });
        const centralOffset = cursor;
        entries.forEach(entry => {
            const central = new DataView(output.buffer, cursor, 46 + entry.pathBytes.length);
            writeUint32(central, 0, 0x02014b50);
            writeUint16(central, 4, 20);
            writeUint16(central, 6, 20);
            writeUint16(central, 8, 0x0800);
            writeUint16(central, 10, 0);
            writeUint16(central, 12, 0);
            writeUint16(central, 14, 0);
            writeUint32(central, 16, entry.crc);
            writeUint32(central, 20, entry.data.length);
            writeUint32(central, 24, entry.data.length);
            writeUint16(central, 28, entry.pathBytes.length);
            writeUint16(central, 30, 0);
            writeUint16(central, 32, 0);
            writeUint16(central, 34, 0);
            writeUint16(central, 36, 0);
            writeUint32(central, 38, 0);
            writeUint32(central, 42, entry.offset);
            output.set(entry.pathBytes, cursor + 46);
            cursor += 46 + entry.pathBytes.length;
        });
        const end = new DataView(output.buffer, cursor, 22);
        writeUint32(end, 0, 0x06054b50);
        writeUint16(end, 4, 0);
        writeUint16(end, 6, 0);
        writeUint16(end, 8, entries.length);
        writeUint16(end, 10, entries.length);
        writeUint32(end, 12, centralSize);
        writeUint32(end, 16, centralOffset);
        writeUint16(end, 20, 0);
        return new Blob([output], { type: 'application/zip' });
    }

    async function extractZip(blob) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const entries = [];
        let offset = 0;
        while (offset + 30 <= bytes.length) {
            const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
            if (view.getUint32(0, true) !== 0x04034b50) break;
            const compression = view.getUint16(8, true);
            const compressedSize = view.getUint32(18, true);
            const nameLength = view.getUint16(26, true);
            const extraLength = view.getUint16(28, true);
            if (compression !== 0) throw new Error('仅支持本应用创建的未压缩 ZIP');
            const nameStart = offset + 30;
            const dataStart = nameStart + nameLength + extraLength;
            const dataEnd = dataStart + compressedSize;
            if (dataEnd > bytes.length) throw new Error('ZIP 文件损坏');
            const path = new TextDecoder().decode(bytes.slice(nameStart, nameStart + nameLength));
            entries.push({ path, data: bytes.slice(dataStart, dataEnd) });
            offset = dataEnd;
        }
        return entries;
    }

    global.FolderArchive = { createZip, extractZip };
})(window);
