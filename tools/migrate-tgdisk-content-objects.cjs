'use strict';
// Offline structural upgrade only. No Telegram calls or inferred content hashes.
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
const {DatabaseSync,backup}=require('node:sqlite');
const {openDiskRepository}=require('../server/disk-repository');
function inventory(db){
    const has=name=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
    if(!has('disk_files'))throw new Error('指定数据库没有 disk_files；请先迁移旧 JSON');
    const logical=db.prepare("SELECT count(*) AS total,sum(CASE WHEN json_extract(payload,'$.reviewStatus')='deleted' THEN 1 ELSE 0 END) AS tombstones FROM disk_files").get();
    const result={schemaVersion:has('disk_schema_migrations') ? Number(db.prepare('SELECT MAX(version) AS version FROM disk_schema_migrations').get().version) || 0 : 0,
        logicalFiles:logical.total,tombstones:logical.tombstones || 0,bindings:0,unbound:logical.total-(logical.tombstones || 0),contents:0,hashStates:[],states:[],anchors:0,canonicalKeys:0,cleanup:[],conflicts:[],referenceMismatches:0,physicalWarningCount:0,physicalWarnings:[],
        scopes:db.prepare('SELECT scope,count(*) AS files FROM disk_files GROUP BY scope').all(),
        relatedRecords:Object.fromEntries(['directories','shares','collaborations'].map(table=>[table,has('disk_'+table)?db.prepare('SELECT count(*) AS n FROM disk_'+table).get().n:0]))};
    if(!has('disk_contents'))return result;
    result.bindings=db.prepare('SELECT count(*) AS n FROM disk_content_refs').get().n;
    result.unbound=db.prepare("SELECT count(*) AS n FROM disk_files f LEFT JOIN disk_content_refs r ON r.scope=f.scope AND r.logical_file_id=f.id WHERE r.content_id IS NULL AND coalesce(json_extract(f.payload,'$.reviewStatus'),'')!='deleted'").get().n;
    result.contents=db.prepare('SELECT count(*) AS n FROM disk_contents').get().n;
    result.hashStates=db.prepare('SELECT hash_status,count(*) AS count FROM disk_contents GROUP BY hash_status').all();
    result.states=db.prepare('SELECT state,count(*) AS count FROM disk_contents GROUP BY state').all();
    result.anchors=db.prepare('SELECT count(*) AS n FROM disk_content_anchors').get().n;
    result.canonicalKeys=db.prepare('SELECT count(*) AS n FROM disk_content_keys').get().n;
    result.cleanup=db.prepare('SELECT purpose,state,count(*) AS count FROM disk_content_cleanup GROUP BY purpose,state').all();
    result.quarantinedHistory=has('disk_content_legacy_history') ? db.prepare('SELECT count(*) AS n FROM disk_content_legacy_history').get().n : 0;
    result.conflicts=db.prepare("SELECT id FROM disk_contents WHERE hash_status='anchor_conflict'").all().map(row=>row.id);
    result.referenceMismatches=db.prepare("SELECT count(*) AS n FROM disk_content_refs r JOIN disk_files f ON r.scope=f.scope AND r.logical_file_id=f.id WHERE json_extract(f.payload,'$.contentId') IS NOT r.content_id OR json_extract(f.payload,'$.logicalContentVersion') IS NOT r.content_version").get().n;
    result.unresolvedPublicRevisions=db.prepare("SELECT count(*) AS n FROM disk_content_revisions WHERE json_extract(payload,'$.channelId') LIKE '@%' OR json_extract(payload,'$.channelId') LIKE '%t.me/%'").get().n;
    for(const row of db.prepare("SELECT c.id,c.size,v.revision,v.payload FROM disk_contents c JOIN disk_content_revisions v ON v.content_id=c.id WHERE v.state!='CLEANED'").all()) {
        const physical=JSON.parse(row.payload),reasons=[];let end=0;
        for(const part of physical.parts || []) {
            if(part.offset!==end || !Number.isSafeInteger(part.size) || part.size<=0)reasons.push('invalid-part-layout');
            if(!part.fileId || !Number.isSafeInteger(part.messageId) || part.messageId<=0)reasons.push('missing-part-location');
            end=Number(part.offset)+Number(part.size || 0);
        }
        if(end!==row.size)reasons.push('incomplete-size');
        if(row.size>0 && !/^-?\d+$/.test(physical.channelId))reasons.push('unresolved-chat');
        if(physical.backendId && (!has('disk_backends') || !db.prepare('SELECT 1 FROM disk_backends WHERE id=?').get(physical.backendId)))reasons.push('unknown-backend');
        if(reasons.length){result.physicalWarningCount++;if(result.physicalWarnings.length<200)result.physicalWarnings.push({contentId:row.id,revision:row.revision,reasons:[...new Set(reasons)]});}
    }
    return result;
}
async function main(argv=process.argv.slice(2)){
    let dataDir=process.env.TUNNEL_DATA_DIR || '.tunnel-data',apply=false,stopped=false;
    for(let i=0;i<argv.length;i++){
        if(argv[i]==='--data-dir'){if(!argv[i+1] || argv[i+1].startsWith('--'))throw new Error('--data-dir 缺少目录');dataDir=argv[++i];}
        else if(argv[i]==='--apply')apply=true;
        else if(argv[i]==='--service-stopped')stopped=true;
        else throw new Error('不支持的参数：'+argv[i]);
    }
    if(apply && !stopped)throw new Error('--apply 必须先停止所有本站 Node 实例及自动重启，再传入 --service-stopped');
    dataDir=path.resolve(dataDir);const filename=path.join(dataDir,'disk.sqlite');
    if(!fs.existsSync(filename) || !fs.lstatSync(filename).isFile())throw new Error('找不到现有 disk.sqlite；本工具不会创建空数据库');
    const db=new DatabaseSync(filename,{readOnly:true});let before,backupFile;
    try{
        db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');
        if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok' || db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('数据库完整性/外键检查失败，停止迁移');
        before=inventory(db);
        if(apply){
            const root=path.join(dataDir,'migration-backups');fs.mkdirSync(root,{recursive:true});
            backupFile=path.join(root,'content-objects-'+Date.now()+'-'+crypto.randomUUID()+'.sqlite');await backup(db,backupFile);
        }
    }finally{db.close();}
    if(!apply)return {mode:'dry-run',database:filename,migrationRequired:before.schemaVersion<2 || before.unbound>0,...before};
    const repository=openDiskRepository(dataDir);
    try{repository.assertIntegrity();repository.checkpoint();const after=repository.content.withDatabase(inventory);
        if(after.unbound || after.referenceMismatches)throw new Error('迁移后绑定核验失败；请保留备份并停服排查');
        return {mode:'applied',database:filename,backup:backupFile,before,after,warning:after.conflicts.length?'重叠 Anchor 已隔离 GC，请核对报告中的 Content ID':undefined};
    }finally{repository.close();}
}
if(require.main===module)main().then(report=>console.log(JSON.stringify(report,null,2))).catch(error=>{console.error('Content 迁移失败：'+error.message);process.exitCode=1;});
module.exports={main,inventory};
