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
        const normalized = path.split('/').filter(part => part && part !== '.' && part !== '..').join('/');
        return path.endsWith('/') && normalized ? `${normalized}/` : normalized;
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
        const MAX_ARCHIVE=256*1024*1024,MAX_FILE=64*1024*1024,MAX_TOTAL=256*1024*1024,MAX_ENTRIES=4096;
        if(blob.size>MAX_ARCHIVE)throw new Error('网页 ZIP 超出安全大小上限');
        const started=Date.now();
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const entries = [];
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let endOffset = -1;
        for (let cursor = Math.max(0, bytes.length - 65557); cursor <= bytes.length - 22; cursor++) {
            if (view.getUint32(cursor, true) === 0x06054b50) endOffset = cursor;
        }
        if (endOffset < 0) throw new Error('ZIP 文件缺少中央目录');
        const entryCount = view.getUint16(endOffset + 10, true);
        if(entryCount>MAX_ENTRIES)throw new Error('网页 ZIP 文件项过多');
        let offset = view.getUint32(endOffset + 16, true);
        const decoder = new TextDecoder();
        let expanded=0;
        for (let index = 0; index < entryCount; index++) {
            if(Date.now()-started>20000)throw new Error('网页 ZIP 解压超过安全时间上限');
            if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
            const compression = view.getUint16(offset + 10, true);
            const compressedSize = view.getUint32(offset + 20, true);
            const uncompressedSize=view.getUint32(offset+24,true);
            if(uncompressedSize>MAX_FILE||expanded+uncompressedSize>MAX_TOTAL)throw Error('网页 ZIP 解压大小超过安全上限');
            const nameLength = view.getUint16(offset + 28, true);
            const extraLength = view.getUint16(offset + 30, true);
            const commentLength = view.getUint16(offset + 32, true);
            const localOffset = view.getUint32(offset + 42, true);
            const path = decoder.decode(bytes.slice(offset + 46, offset + 46 + nameLength)).replace(/\\/g, '/');
            if (!path.endsWith('/')) {
                if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('ZIP 文件项损坏');
                const localNameLength = view.getUint16(localOffset + 26, true);
                const localExtraLength = view.getUint16(localOffset + 28, true);
                const dataStart = localOffset + 30 + localNameLength + localExtraLength;
                const compressed = bytes.slice(dataStart, dataStart + compressedSize);
                let data;
                if (compression === 0) data = compressed;
                else if (compression === 8 && typeof DecompressionStream === 'function') {
                    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
                    const reader=stream.getReader(),chunks=[];let size=0;
                    try{
                        while(true){
                            if(Date.now()-started>20000)throw Error('网页 ZIP 解压超过安全时间上限');
                            const {done,value}=await reader.read();if(done)break;
                            size+=value.byteLength;
                            if(size>MAX_FILE||expanded+size>MAX_TOTAL)throw Error('网页 ZIP 解压大小超过安全上限');
                            chunks.push(value);
                        }
                    }catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
                    data=new Uint8Array(size);let write=0;for(const chunk of chunks){data.set(chunk,write);write+=chunk.byteLength;}
                } else if (compression === 8) throw new Error('当前浏览器不支持解压 Deflate ZIP');
                else throw new Error(`不支持 ZIP 压缩方式 ${compression}`);
                if(data.length!==uncompressedSize)throw Error('网页 ZIP 文件尺寸校验失败');
                expanded+=data.length;
                entries.push({ path: normalizePath({ path }), data });
            } else entries.push({ path:normalizePath({ path }), data:new Uint8Array() });
            offset += 46 + nameLength + extraLength + commentLength;
        }
        return entries;
    }

    global.FolderArchive = { createZip, extractZip };
})(window);
