const fs=require('fs'),path=require('path'),crypto=require('crypto');
const sharp=require('C:/Users/Dell/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const out='D:/Workspace/github/Ltre/file-tunnel/prompts/resources/streaming-console-QA-261016/v3';
const baseline=JSON.parse(fs.readFileSync(path.join(process.env.TEMP,'stream-v3-theme-before.json'),'utf8'));
const canonical=s=>s.replace(/#[0-9a-f]{8}\b|#[0-9a-f]{6}\b/gi,'#COLOR');
(async()=>{
 for(const [f,hash]of Object.entries(baseline.before)){
  const svg=fs.readFileSync(path.join(out,f),'utf8');
  if(crypto.createHash('sha256').update(canonical(svg)).digest('hex')!==hash)throw Error('Non-color SVG change: '+f);
  for(const c of baseline.oldColors)if(svg.toLowerCase().includes(c))throw Error('Warm color remains: '+f+' '+c);
 }
 if(crypto.createHash('sha256').update(fs.readFileSync(path.join(out,'info.txt'))).digest('hex')!==baseline.infoHash)throw Error('info.txt changed');
 for(const f of ['02-discovery.png','03-create-edit.png','23-mobile-navigation.png','34-imported-eight.png']){
  const {data,info}=await sharp(path.join(out,f)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  if(data[0]!==255||data[1]!==255||data[2]!==255)throw Error('Main background is not white in '+f);
 }
 console.log('All 41 SVGs retain identical geometry, text and links after excluding color values.');
 console.log('No old warm palette remains in SVGs. Sampled desktop/mobile backgrounds are pure white. info.txt unchanged.');
})().catch(e=>{console.error(e);process.exitCode=1;});
