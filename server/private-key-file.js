'use strict';
const fs=require('node:fs'),path=require('node:path');
// O_EXCL prevents simultaneous Node instances from replacing each other's key.
function privateKeyFile(filename,create){fs.mkdirSync(path.dirname(filename),{recursive:true});try{fs.writeFileSync(filename,create(),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}const key=fs.readFileSync(filename,'utf8').trim();if(!key)throw Error('PERSISTED_SIGNING_KEY_EMPTY');try{fs.chmodSync(filename,0o600);}catch(_){}return key;}
module.exports={privateKeyFile};
