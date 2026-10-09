'use strict';
const DEFAULTS = Object.freeze({ folderUploadMaxBytes: 500_000_000, maxDirectoryDepth: 30 });
function createDiskUserSettings(repository) {
    const get = ownerId => ({ ...DEFAULTS, ...repository.load('user_settings').find(item => item.id === String(ownerId)) });
    return { get, update(ownerId, input) {
        if (!input || Object.keys(input).some(key => !Object.hasOwn(DEFAULTS,key))) throw new Error('DISK_SETTINGS_INVALID');
        return repository.atomic(() => {
            const next = { ...get(ownerId), ...input, id:String(ownerId) };
            if (!Number.isSafeInteger(next.maxDirectoryDepth) || next.maxDirectoryDepth<1 || next.maxDirectoryDepth>30
                || !Number.isSafeInteger(next.folderUploadMaxBytes) || next.folderUploadMaxBytes<1 || next.folderUploadMaxBytes>2_000_000_000_000) throw new Error('DISK_SETTINGS_INVALID');
            const items=repository.load('user_settings').filter(item=>item.id!==next.id);
            repository.replace('user_settings',[...items,next],item=>item.id);return next;
        });
    } };
}
module.exports={createDiskUserSettings,DEFAULTS};
