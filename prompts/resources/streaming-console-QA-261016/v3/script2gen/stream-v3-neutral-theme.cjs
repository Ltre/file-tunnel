const fs=require('fs'),path=require('path'),crypto=require('crypto');
const out='D:/Workspace/github/Ltre/file-tunnel/prompts/resources/streaming-console-QA-261016/v3';
const file=path.join(out,'script2gen/streaming-console-v3-build.cjs');
const colors={
 '#28251f':'#191919','#30281d':'#000000','#302a22':'#262626','#3e3525':'#000000',
 '#42351f12':'#00000012','#473c2d':'#000000','#51483a':'#404040','#595648':'#555555',
 '#63715b':'#25804d','#645137':'#404040','#68614f':'#666666','#756345':'#606060',
 '#8a7c67':'#737373','#956826':'#666666','#a7473f':'#a73737','#aea58e':'#a8a8a8',
 '#bdb09b':'#bdbdbd','#d3cbb4':'#d2d2d2','#d9cbb0':'#d9d9d9','#e0d1b5':'#dedede',
 '#e1d4bd':'#e1e1e1','#e3d4b7':'#e3e3e3','#e6dac4':'#dedede','#e7d8bc':'#e7e7e7',
 '#e8deca':'#e8e8e8','#e9dfcb':'#e9e9e9','#e9e0ce':'#e9e9e9','#edf0e4':'#edf7f0',
 '#efe2c5':'#eeeeee','#efe6d3':'#f2f2f2','#f4e8cf':'#eeeeee','#f5ead4':'#f1f1f1',
 '#f6efdf':'#ffffff','#fbebe4':'#fff0f0','#fff1d5':'#f4f4f4','#fff2d8':'#f1f1f1',
 '#fff5dc':'#ffffff','#fff5de':'#f1f1f1','#fff7e4':'#f8f8f8','#fff7e7':'#f7f7f7',
 '#fff7e9':'#ffffff','#fff8e7':'#fafafa','#fff8e9':'#f8f8f8','#fff9ed':'#fafafa',
 '#fffaed':'#ffffff','#fffaef':'#ffffff','#fffaf0':'#ffffff','#fffaf1':'#ffffff',
 '#fffbed':'#ffffff','#fffbee':'#ffffff','#fffcf5':'#ffffff','#fffdf4':'#ffffff',
 '#fffdf5':'#ffffff','#fffdf6':'#ffffff','#fffdf7':'#ffffff','#fffdf8':'#ffffff'
};
function canonical(s){return s.replace(/#[0-9a-f]{8}\b|#[0-9a-f]{6}\b/gi,'#COLOR');}
const before={};for(const f of fs.readdirSync(out).filter(f=>f.endsWith('.svg'))){const s=fs.readFileSync(path.join(out,f),'utf8');before[f]=crypto.createHash('sha256').update(canonical(s)).digest('hex');}
const infoHash=crypto.createHash('sha256').update(fs.readFileSync(path.join(out,'info.txt'))).digest('hex');
fs.writeFileSync(path.join(process.env.TEMP,'stream-v3-theme-before.json'),JSON.stringify({before,infoHash,oldColors:Object.keys(colors)}));
let source=fs.readFileSync(file,'utf8');
source=source.replace(/#[0-9a-f]{8}\b|#[0-9a-f]{6}\b/gi,c=>{if(!colors[c])throw Error('Unmapped color '+c);return colors[c];});
source=source.replace('## 布局依据\\n\\n参考：','## 布局依据\\n\\n配色恢复为白色主背景与中性灰控件；参考图的偏黄来自查看器色彩配置，不作为设计配色依据。\\n\\n参考：');
source=source.replace('## 概念版布局保留\\n\\n','## 概念版布局保留\\n\\n仅沿用参考图布局，配色使用正常白色与中性灰；不沿用查看器造成的偏黄效果。\\n\\n');
fs.writeFileSync(file,source);
console.log('Updated stored v3 generator: '+Object.keys(colors).length+' warm colors mapped to neutral palette. Snapshot saved for layout comparison.');
