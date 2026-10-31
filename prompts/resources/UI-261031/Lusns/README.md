# 隧道首页 Lusns 主题原型

本目录的方案命名为 Lusns，从现有 Lumen 主题派生，参考 `index.jpg` 的蓝紫色渐变和浅蓝背景条纹调整配色。全局顶栏透明，窄屏的连接设备和协同编辑标题也透明；目前仅为原型，尚未接入产品主题列表。

直接用浏览器打开 [tunnel-prototype.html](tunnel-prototype.html)。页面采用当前分支首页的三栏结构和 Lumen 基础样式；[tunnel-prototype.css](tunnel-prototype.css) 只覆盖配色、背景、边框颜色与阴影。

可查看暗号下拉、设置、资源浏览器、记录菜单和详情、设备资料、通知中心、备份、清理及富文本等演示状态。窄屏可切换连接、隧道、协同三页；在隧道页再次点击底部“隧道”可查看控制中心。

`index.jpg` 是最初提供的参考图，保留原样；当前原型的截图集中在 [screenshots](screenshots/) 目录，重新生成时也会同步更新根目录的同名截图。

- [桌面首页](screenshots/tunnel-home.png) · [宽屏](screenshots/tunnel-wide.png) · [暗号下拉](screenshots/tunnel-dropdown.png)
- [设置](screenshots/tunnel-settings.png) · [资源浏览器](screenshots/tunnel-resources.png) · [记录菜单](screenshots/tunnel-record-menu.png) · [记录详情](screenshots/tunnel-details.png)
- [手机连接](screenshots/mobile-devices.png) · [手机隧道](screenshots/mobile-chat.png) · [手机协同](screenshots/mobile-editor.png) · [手机控制中心](screenshots/mobile-control-center.png)
- [SVG 首页](tunnel-home.svg) · [检查结果](prototype-check.json)

HTML 使用演示数据和部分交互模拟，不连接真实隧道；二维码仅为示意图。文件预览对话框不在本次原型设计范围内，产品中继续使用现有实现。

SVG 使用 foreignObject 保留 HTML/CSS 结构，示例缩略图为嵌入图片；可在 Chrome、Edge 中查看，部分矢量编辑器可能不支持此结构。

检查结果比较的是同一份原型结构在 Lusns 配色和当前 Lumen 基础样式下的几何与指定状态，并非真实设备及完整业务流程验收。

参考这份原型时，不要修改原系统前端UI组件的大小、位置、字体、内容，只修改背景、阴影、渐变等跟配色有关的样式。
