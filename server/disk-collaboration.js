'use strict';

const crypto = require('crypto');
const { openDiskRepository } = require('./disk-repository');

function createDiskCollaborationStore(dataDir) {
    const repository = openDiskRepository(dataDir);
    let state = repository.loadWithRevision('collaborations');
    const entries = state.items;
    const reloadPersistence = () => {
        state = repository.loadWithRevision('collaborations');
        entries.splice(0, entries.length, ...state.items);
    };
    const save = () => {
        try { repository.replaceMany([{ table:'collaborations', items:entries, keyOf:item => item.id, base:state.revisions }]); }
        catch (error) {
            reloadPersistence();
            throw error;
        }
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
        reloadPersistence,
        find,
        publicEntry,
        accessible(userId) { return entries.filter(item => item.active !== false && (item.ownerId === String(userId) || item.members.includes(String(userId)))).map(publicEntry); },
        authorized(id, userId) { const item = find(id); return item && (item.ownerId === String(userId) || item.members.includes(String(userId)))
            ? { ...item, grantVersion: Number(item.memberVersions?.[String(userId)]) || 1 } : null; },
        ownedTarget(ownerId, diskSpace, kind, target) { return entries.find(item => item.active !== false && sameScope(item,ownerId,diskSpace) && item.kind === kind && (kind === 'file' ? item.fileId === target : item.path === target)) || null; },
        byInvite(token) { return entries.find(item => item.active !== false && item.invites.some(invite => invite.token === String(token))) || null; },
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
            const item = this.byInvite(token);
            if (!item) throw new Error('INVITE_NOT_FOUND');
            if (item.ownerId === String(userId)) return publicEntry(item);
            item.invites = item.invites.filter(invite => invite.token !== token);
            if (!item.members.includes(String(userId))) {
                item.members.push(String(userId));
                item.memberVersions ||= {};
                item.memberVersions[String(userId)] = (Number(item.memberVersions[String(userId)]) || 0) + 1;
            }
            save(); return publicEntry(item);
        },
        revokeInvite(id, inviteId, ownerId, diskSpace) { const item=ensureOwner(id,ownerId,diskSpace);const before=item.invites.length;item.invites=item.invites.filter(invite=>invite.id!==inviteId);if(before===item.invites.length)throw new Error('INVITE_NOT_FOUND');save();return publicEntry(item); },
        kick(id, memberId, ownerId, diskSpace) { const item=ensureOwner(id,ownerId,diskSpace);item.members=item.members.filter(id=>id!==String(memberId));
            item.memberVersions ||= {};item.memberVersions[String(memberId)]=(Number(item.memberVersions[String(memberId)]) || 1)+1;
            save();return publicEntry(item); },
        disable(id, ownerId, diskSpace) { const item=ensureOwner(id,ownerId,diskSpace);item.active=false;item.invites=[];item.members=[];save();return { ok:true }; },
        protectFile(ownerId,diskSpace,fileId) { return entries.some(item=>item.active!==false&&sameScope(item,ownerId,diskSpace)&&item.kind==='file'&&item.fileId===fileId); },
        protectDirectory(ownerId,diskSpace,folderPath) { const prefix=`${folderPath}/`;return entries.some(item=>item.active!==false&&sameScope(item,ownerId,diskSpace)&&(item.path===folderPath||item.path.startsWith(prefix))); },
        relocateDirectory(ownerId,diskSpace,oldPath,newPath) { let changed=false;for(const item of entries){if(item.active===false||!sameScope(item,ownerId,diskSpace))continue;if(item.path===oldPath||item.path.startsWith(`${oldPath}/`)){item.path=newPath+item.path.slice(oldPath.length);changed=true;}}if(changed)save(); },
        relocateFile(ownerId,diskSpace,fileId,newPath,newName) { const item=this.ownedTarget(ownerId,diskSpace,'file',fileId);if(!item)return;item.path=newPath;item.name=newName;save(); },
        forOwner(ownerId,diskSpace) { return entries.filter(item=>item.active!==false&&sameScope(item,ownerId,diskSpace)).map(publicEntry); }
    };
}

module.exports = { createDiskCollaborationStore };
