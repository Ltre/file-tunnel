'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createDiskCollaborationStore(dataDir) {
    const file = path.join(dataDir, 'disk-collaborations.json');
    let entries = [];
    try { entries = JSON.parse(fs.readFileSync(file, 'utf8')); if (!Array.isArray(entries)) entries = []; } catch (_) {}
    const save = () => {
        fs.mkdirSync(path.dirname(file), { recursive:true });
        const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(entries, null, 2));
        fs.renameSync(temp, file);
    };
    const sameScope = (item, ownerId, diskSpace) => item.ownerId === String(ownerId) && item.diskSpace === String(diskSpace || '');
    const publicEntry = item => ({ id:item.id, ownerId:item.ownerId, diskSpace:item.diskSpace, kind:item.kind, path:item.path || '', fileId:item.fileId || '', name:item.name, members:item.members.slice(), invites:item.invites.map(invite => ({ id:invite.id, token:invite.token, createdAt:invite.createdAt })), createdAt:item.createdAt });
    const find = id => entries.find(item => item.id === String(id) && item.active !== false);
    const ensureOwner = (id, ownerId, diskSpace) => {
        const item = find(id);
        if (!item || !sameScope(item, ownerId, diskSpace)) throw new Error('COLLABORATION_NOT_FOUND');
        return item;
    };
    return {
        find,
        publicEntry,
        accessible(userId) { return entries.filter(item => item.active !== false && (item.ownerId === String(userId) || item.members.includes(String(userId)))).map(publicEntry); },
        authorized(id, userId) { const item = find(id); return item && (item.ownerId === String(userId) || item.members.includes(String(userId))) ? item : null; },
        ownedTarget(ownerId, diskSpace, kind, target) { return entries.find(item => item.active !== false && sameScope(item,ownerId,diskSpace) && item.kind === kind && (kind === 'file' ? item.fileId === target : item.path === target)) || null; },
        enable({ ownerId, diskSpace = '', kind, path:folderPath = '', fileId = '', name }) {
            const target = kind === 'file' ? fileId : folderPath;
            let item = this.ownedTarget(ownerId,diskSpace,kind,target);
            if (!item) {
                item = { id:crypto.randomUUID(), ownerId:String(ownerId), diskSpace:String(diskSpace), kind, path:folderPath, fileId, name, members:[], invites:[], createdAt:Date.now(), active:true };
                entries.push(item);
            }
            item.name = name;
            const invite = { id:crypto.randomUUID(), token:crypto.randomBytes(32).toString('base64url'), createdAt:Date.now() };
            item.invites.push(invite); save();
            return { collaboration:publicEntry(item), invite };
        },
        join(token, userId) {
            const item = entries.find(entry => entry.active !== false && entry.invites.some(invite => invite.token === token));
            if (!item) throw new Error('INVITE_NOT_FOUND');
            if (item.ownerId === String(userId)) throw new Error('INVITE_OWNER_CANNOT_JOIN');
            item.invites = item.invites.filter(invite => invite.token !== token);
            if (!item.members.includes(String(userId))) item.members.push(String(userId));
            save(); return publicEntry(item);
        },
        revokeInvite(id, inviteId, ownerId, diskSpace) { const item=ensureOwner(id,ownerId,diskSpace);const before=item.invites.length;item.invites=item.invites.filter(invite=>invite.id!==inviteId);if(before===item.invites.length)throw new Error('INVITE_NOT_FOUND');save();return publicEntry(item); },
        kick(id, memberId, ownerId, diskSpace) { const item=ensureOwner(id,ownerId,diskSpace);item.members=item.members.filter(id=>id!==String(memberId));save();return publicEntry(item); },
        disable(id, ownerId, diskSpace) { const item=ensureOwner(id,ownerId,diskSpace);item.active=false;item.invites=[];item.members=[];save();return { ok:true }; },
        protectFile(ownerId,diskSpace,fileId) { return entries.some(item=>item.active!==false&&sameScope(item,ownerId,diskSpace)&&item.kind==='file'&&item.fileId===fileId); },
        protectDirectory(ownerId,diskSpace,folderPath) { const prefix=`${folderPath}/`;return entries.some(item=>item.active!==false&&sameScope(item,ownerId,diskSpace)&&(item.path===folderPath||item.path.startsWith(prefix))); },
        relocateDirectory(ownerId,diskSpace,oldPath,newPath) { let changed=false;for(const item of entries){if(item.active===false||!sameScope(item,ownerId,diskSpace))continue;if(item.path===oldPath||item.path.startsWith(`${oldPath}/`)){item.path=newPath+item.path.slice(oldPath.length);changed=true;}}if(changed)save(); },
        relocateFile(ownerId,diskSpace,fileId,newPath,newName) { const item=this.ownedTarget(ownerId,diskSpace,'file',fileId);if(!item)return;item.path=newPath;item.name=newName;save(); },
        forOwner(ownerId,diskSpace) { return entries.filter(item=>item.active!==false&&sameScope(item,ownerId,diskSpace)).map(publicEntry); }
    };
}

module.exports = { createDiskCollaborationStore };
