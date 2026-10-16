const fs=require('fs');const file='C:/Users/Dell/AppData/Local/Temp/streaming-console-v3-build.cjs';let s=fs.readFileSync(file,'utf8');
s=s.replaceAll('随机仅用于挑选待导入资源；抽取范围与数量可设','随机结果作为当前台统一队列；抽取范围与数量可设').replaceAll('窄屏页面见 23–26，媒体主动沉浸全屏见 27。','窄屏页面见 23–26；文件、实时画面与监控媒体全屏分别见 27、38、39，实时接收见 36，布局预设见 37。').replaceAll('指定范围、数量，检查抽取结果后确认导入','指定范围、数量，确认后保存当前台统一随机队列；后续续抽也由台统一决定').replaceAll('媒体主动沉浸全屏与退出 | 27 |','媒体主动沉浸全屏与退出 | 27、38、39 |').replaceAll('从原版 v2 补回的功能','从原版 v2 补回的功能');
s=s.replaceAll('- 同台共享当前文件、播放 / 暂停和目标进度；','- 随机来源保存抽取范围及台统一生成的资源队列；继续抽取也由同一台统一更新，不允许每个接收端各自随机。图中演示首批候选确认导入的过程。\\n- 同台共享当前文件、播放 / 暂停和目标进度；');
fs.writeFileSync(file,s);console.log('Updated coverage and context-specific fullscreen states.');
