'use strict';
function moment(ms){const seconds=Math.max(0,Math.round(Number(ms)||0))/1000,h=Math.floor(seconds/3600),m=Math.floor(seconds%3600/60),s=Number((seconds%60).toFixed(3));return h?`${h}h${m}m${s}`:m?`${m}m${s}`:`${s}s`;}
function field(value){let out='';for(const c of String(value||'').replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').trim()){if(Buffer.byteLength(out+c)>70)break;out+=c;}return out.replace(/[. ]+$/,'');}
function clipName(session,result){return [String(session.id).slice(0,8),field(session.name)||'提取会话',field(result.remark),moment(result.startMs),moment(result.endMs)].filter(Boolean).join('-');}
function compressionName(session,result,variant){if(!Number.isSafeInteger(result.clipOrdinal)||result.clipOrdinal<1)throw Error('MEDIA_CLIP_ORDINAL_MISSING');return clipName(session,result)+'-CLIP'+result.clipOrdinal+'-压'+variant.ordinal+'-'+variant.quality.width+'x'+variant.quality.height;}
module.exports={clipName,moment,compressionName};
