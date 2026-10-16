const fs=require('fs');const file='C:/Users/Dell/AppData/Local/Temp/streaming-console-v3-build.cjs';let s=fs.readFileSync(file,'utf8');
s=s.replace('## 布局依据\\n\\n主要布局','## 布局依据\\n\\n参考：[概念版 v2](../傻逼gptchat异想天开的专业UI/v2/)、[概念版 v1](../傻逼gptchat异想天开的专业UI/v1/)、[原版 v2](../v2/)。\\n\\n主要布局');
s=s.replace('收到邀请见 33，异常与恢复见 19。','收到邀请见 33，手动批量 / 单个踢出确认见 40 / 41，异常与恢复见 19。');
s=s.replace('确认后 5 + 3 = 8 项。','确认后 5 + 3 = 8 项。图 35 保存后返回我创建的台列表。');
s=s.replace('本次仅制作设计图、离线浏览页和设计说明，','已检查全部 SVG 解析与 PNG 输出，并核对离线浏览页的主要跳转；窄屏原型为独立布局设计，实际移动端手势仍需开发后验收。\\n\\n本次仅制作设计图、离线浏览页和设计说明，');
fs.writeFileSync(file,s);console.log('Finalized design document links and confirmation semantics.');
