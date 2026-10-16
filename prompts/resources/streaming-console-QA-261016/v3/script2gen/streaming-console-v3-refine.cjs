const fs=require('fs');
const file='C:/Users/Dell/AppData/Local/Temp/streaming-console-v3-build.cjs';
let s=fs.readFileSync(file,'utf8');
const changes=[
 ["function listShell(a,current){canvas(a);controls(a);sidebar(a,current);a.text(299,82,current==='发现的串流台'?'范围：同一隧道与已关注设备':'台配置与订阅均可保留并重复使用',12,P.muted);a.btn(1375,72,193,'↻ 正在自动发现…',{to:'02-discovery',h:39,small:true});tabs(a,296,129,[['全部  6','02-discovery'],['公开  4','02-discovery'],['仅限邀请  2','18-accept-invitation'],['直播中  3','02-discovery'],['文件点播  3','02-discovery']],'全部  6',137);}",
  "function listShell(a,current){canvas(a);controls(a);sidebar(a,current);const discover=current==='发现的串流台',created=current==='我创建的串流台';a.text(299,82,discover?'范围：同一隧道与已关注设备':'台配置与订阅均可保留并重复使用',12,P.muted);if(discover)a.btn(1375,72,193,'↻ 正在自动发现…',{to:'02-discovery',h:39,small:true});else a.text(1568,91,created?'本设备已保存 3 个串流台':'已保留 3 个订阅',13,P.muted,500,'end');const list=discover?[['全部  6','02-discovery'],['公开  4','02-discovery'],['仅限邀请  2','33-accept-invitation'],['直播中  3','02-discovery'],['文件点播  3','02-discovery']]:created?[['全部  3','10-my-stations'],['公开  1','10-my-stations'],['仅限邀请  1','10-my-stations'],['下线  1','10-my-stations']]:[['全部  3','11-my-subscriptions'],['在线  2','11-my-subscriptions'],['下线  1','11-my-subscriptions']];tabs(a,296,129,list,list[0][0],137);}"],
 ["'屏幕共享','仅限邀请','LIVE','1 台接收','打开控制','06-owner'","'屏幕共享','仅限邀请','LIVE','1 台接收','打开控制','32-live-active'"],
 ["'摄像头','公开','LIVE','已订阅','打开观看','07-receiver'","'摄像头','公开','LIVE','已订阅','打开观看','36-receiver-live'"],
 ["'摄像头','公开','LIVE','1 人观看','订阅并打开','07-receiver'","'摄像头','公开','LIVE','1 人观看','订阅并打开','36-receiver-live'"],
 ["'屏幕共享','仅限邀请','LIVE','授权有效','打开观看','07-receiver'","'屏幕共享','仅限邀请','LIVE','授权有效','打开观看','36-receiver-live'"],
 ["to:mode==='created'?'03-create-edit':'07-receiver'","to:mode==='created'?'03-create-edit':(type==='摄像头'||type==='屏幕共享')?'36-receiver-live':'07-receiver'"],
 ["'U1 · 默认分区 / 相册'","'U1 · 默认分区 ▾ / 相册'"],
 ["'拖动点阵或点击 ↑ / ↓ 排序。这里没有资源勾选框。'","'拖动点阵或点击 ↑ / ↓ 调整播放顺序。'"],
 ["'无勾选框；点按 ↑ ↓ 或拖动点阵排序。'","'点按 ↑ ↓ 或拖动点阵调整播放顺序。'"],
 ["'这里只有候选勾选，不提供排序。'","'确认后加入播放列表，届时可调整顺序。'"],
 ["'方阵手势只作用于本层，不切换首页三栏。'","'切回首页后，方阵仍会继续接收。'"],
 ["['布局预设','18-monitor-nine']","['布局预设','37-monitor-presets']"],
 ["'保存为预设',{to:'18-monitor-nine'","'保存为预设',{to:'37-monitor-presets'"],
 ["'加载预设',{to:'18-monitor-nine'","'加载预设',{to:'37-monitor-presets'"],
 ["'监控清单与布局预设',{to:'08-monitor-wall'","'监控清单与布局预设',{to:'37-monitor-presets'"],
 ["'当前播放（'+(nine?9:4)+'）'","'已加入方阵（'+(nine?9:4)+'）'"],
 ["if(a.id==='18-monitor-nine')a.p=a.p.map(s=>s.replace('当前播放（9）','当前播放 9 · 显示前 4 条').replace('已订阅台（未加入方阵）','继续滚动可查看其余 5 台'));", "if(a.id==='18-monitor-nine'){a.p=a.p.map(s=>s.replace('已加入方阵（9）','方阵 9 · 显示 4 条'));a.text(1182,548,'向下滚动可查看其余 5 台',11,P.muted);a.rect(1557,178,4,347,P.soft);a.rect(1557,178,4,154,P.muted);}"],
 ["pool(a);a.p=a.p.map(s=>s.includes('x=\"')?s:s); // Layout is rebuilt below for the eight-item state.", "// Eight confirmed resources use a more compact row height."],
 ["to:'07-receiver',primary:true,h:48});\n banner(a,276,798", "to:'36-receiver-live',primary:true,h:48});\n banner(a,276,798"],
 [".replaceAll('05-imported-pool.svg','34-imported-eight.svg'));});", ".replaceAll('05-imported-pool.svg','34-imported-eight.svg').replaceAll('06-owner.svg','10-my-stations.svg'));});"],
 ["32、26 |", "32、26、36 |"],
 ["07、31、26、27 |", "07、31、26、27、36 |"],
 ["08、18、26 |", "08、18、26、37 |"]
];
for(const [a,b]of changes){if(!s.includes(a))throw Error('Missing edit target: '+a);s=s.replaceAll(a,b);}
fs.writeFileSync(file,s);
console.log('Refined source and state flow.');
