# 串流控制台 v3 · 窄屏移动原型

[独立移动预览](index.html) · [原 v3 浏览页的移动模式](../index.html?mode=mobile#02-discovery) · [移动版总览](00-overview.png)

## 审核方式

- 推荐打开原 v3 浏览页，选择「移动原型」，切换 320 / 360 / 390 / 430 像素；另外提供 768 像素用于较宽设备对照。
- 移动页使用实际 HTML / CSS 单列与触控布局，不是对 PC SVG 缩放，也不是原来 23–26 的三手机拼图。
- 可滚动查看完整页面，底部主要动作与首页快捷入口保持可达。独立预览可在手机浏览器直接打开；PC 上独立页限制在 480 像素内，完整宽度切换请用原浏览页。
- 共 51 个单页状态，覆盖所有 PC 页面；把播放列表、观看者、预览、监控清单、模板和文档阅读拆成适合手机的独立页。
- 每页附 [previews/](previews/) 下的 390 像素宽 PNG。长页面的 PNG 会展开全部内容；固定视口、滚动与固定底部动作请在交互浏览页审核。
- 原型导航条和原 v3 浏览页工具栏属于审核工具，不是产品顶栏。媒体与权限框均为示意，不连接任何设备或申请真实采集权限。

## 可以直接操作的流程

1. 发现 → 创建 → 管理资源 → 导入，切换本机 / 网盘 / 隧道，跨渠道保留候选选择，查看待导入清单后确认。默认示例 5 + 3 = 8；取消选择后按实际确认数量追加。
2. 已导入列表没有勾选框。可拖动点阵，或用 ↑ / ↓ 排列，也可按名称排序、移除、独立预览。移除不会删除原始文件。
3. 发起端用页内入口切换播放、播放列表和观看者；接收端区分共享播放与本机静音 / 音量。
4. 监控四画面使用每格本机控制；九画面通过点选格子，在下方显示可点按的控制。另有放大、监控清单、布局预设与方阵全屏。
5. 公开转邀请、下线、批量 / 单个踢出分别确认。下线示例保留订阅和方阵位置。
6. 摄像头 / 屏幕 → 原生授权示意 → LIVE。屏幕共享注明移动浏览器能力限制，不假定所有手机均可发起共享。
7. 回首页 → 传输记录 / 协同编辑 → 顶栏串流入口恢复。首页草稿、控制台表单、候选选择与资源顺序保留在本次预览内。

## 首页与手势约束

白色全屏控制台位于原三栏之外。底部「连接设备 / 传输记录 / 协同编辑」是收起并跳到原页面的快捷入口，控制台没有占用或新增原三栏的横滑位置。首页顶栏保留原按钮顺序，只显示 v3 已有的串流恢复入口。

本原型使用独立滚动区、触控按钮和点阵拖动范围表现设计边界；它不加载应用原有三栏侧滑代码，因此不能替代实际开发后的手势验收。实际接入仍需按 v3 设计要求隔离浮层与后台滑动、取消未完成手势、恢复原栏位、处理横竖屏和软键盘。

## PC 对照

| PC 图 | 窄屏页面 | 处理方式 |
| --- | --- | --- |
| 01 首页入口 · 保留现有三栏 | [首页菜单入口](index.html#01-home-entry) | 布局重新排列，不缩小 PC SVG |
| 02 发现与订阅 · 概念版布局 | [发现与订阅](index.html#02-discovery) | 布局重新排列，不缩小 PC SVG |
| 03 创建与编辑 · 左表单右预览 | [创建与编辑串流台](index.html#03-create-edit) | 布局重新排列，不缩小 PC SVG |
| 04 统一来源选择 · 网盘候选 | [导入：网盘候选](index.html#04-source-drive) | 布局重新排列，不缩小 PC SVG |
| 05 已导入资源 · 管理与排序 | [已导入资源与排序](index.html#05-imported-pool) | 布局重新排列，不缩小 PC SVG |
| 06 发起端控制台 · 当前项与观看者 | [发起端：播放与当前项](index.html#06-owner) | 布局重新排列，不缩小 PC SVG |
| 07 接收端观看 · 共享控制与本机音频 | [接收端：文件观看](index.html#07-receiver) | 布局重新排列，不缩小 PC SVG |
| 08 监控大爷模式 · 方阵与右侧列表 | [监控：四画面](index.html#08-monitor-wall) | 布局重新排列，不缩小 PC SVG |
| 09 邀请与可见性管理 · 状态说明 | [邀请与可见性](index.html#09-access) | 布局重新排列，不缩小 PC SVG |
| 10 我创建的串流台 · 持久复用 | [我创建的串流台](index.html#10-my-stations) | 布局重新排列，不缩小 PC SVG |
| 11 我订阅的串流台 · 下线保留 | [我订阅的串流台](index.html#11-my-subscriptions) | 布局重新排列，不缩小 PC SVG |
| 12 统一来源选择 · 本机候选 | [导入：本机候选](index.html#12-source-local) | 布局重新排列，不缩小 PC SVG |
| 13 统一来源选择 · 隧道候选 | [导入：隧道候选](index.html#13-source-tunnel) | 布局重新排列，不缩小 PC SVG |
| 14 摄像头配置 · 主动开始采集 | [摄像头来源配置](index.html#14-camera) | 布局重新排列，不缩小 PC SVG |
| 15 屏幕共享配置 · 浏览器选择 | [屏幕共享来源配置](index.html#15-screen) | 布局重新排列，不缩小 PC SVG |
| 16 随机网盘资源 · 抽取与确认 | [随机网盘资源](index.html#16-random-drive) | 布局重新排列，不缩小 PC SVG |
| 17 随机隧道记录 · 抽取与确认 | [随机隧道记录](index.html#17-random-tunnel) | 布局重新排列，不缩小 PC SVG |
| 18 九宫格监控 · 保存与复用布局 | [监控：九画面与单格控制](index.html#18-monitor-nine) | 布局重新排列，不缩小 PC SVG |
| 19 异常、下线与权限恢复 | [异常、下线与恢复](index.html#19-recovery) | 布局重新排列，不缩小 PC SVG |
| 20 摄像头浏览器授权示意 | [摄像头原生权限示意](index.html#20-camera-permission) | 布局重新排列，不缩小 PC SVG |
| 21 浏览器共享来源选择示意 | [屏幕选择器示意](index.html#21-screen-permission) | 布局重新排列，不缩小 PC SVG |
| 22 返回首页 · 原三栏继续工作 | [首页：连接设备](index.html#22-home-background) | 布局重新排列，不缩小 PC SVG |
| 23 移动端共存 · 收起与恢复 | [首页：传输记录与草稿](index.html#m-home-records) | 原多手机拼图改为对应的真实单页预览 |
| 24 移动端创建与已导入资源排序 | [创建与编辑串流台](index.html#03-create-edit) | 原多手机拼图改为对应的真实单页预览 |
| 25 移动端跨渠道导入 · 不混入排序 | [导入：网盘候选](index.html#04-source-drive) | 原多手机拼图改为对应的真实单页预览 |
| 26 移动端播放与监控 · 窄屏重排 | [发起端：播放与当前项](index.html#06-owner) | 原多手机拼图改为对应的真实单页预览 |
| 27 媒体沉浸全屏 · 主动进入与退出 | [文件媒体全屏](index.html#27-media-fullscreen) | 布局重新排列，不缩小 PC SVG |
| 28 公开转仅邀请 · 踢出确认 | [转为仅限邀请：确认](index.html#28-private-confirm) | 布局重新排列，不缩小 PC SVG |
| 29 排序后 · 当前项移到首位 | [资源排序后](index.html#29-sorted-pool) | 布局重新排列，不缩小 PC SVG |
| 30 串流台下线 · 保留订阅确认 | [串流台下线：确认](index.html#30-offline-confirm) | 布局重新排列，不缩小 PC SVG |
| 31 音频、图片、Markdown 与 TXT | [音频、图片与文本预览入口](index.html#31-media-previews) | 布局重新排列，不缩小 PC SVG |
| 32 实时来源已启动 · LIVE 控制台 | [实时采集：已启动](index.html#32-live-active) | 布局重新排列，不缩小 PC SVG |
| 33 接收邀请 · 校验与加入 | [接收邀请与加入](index.html#33-accept-invitation) | 布局重新排列，不缩小 PC SVG |
| 34 确认导入后 · 混合列表从 5 项到 8 项 | [确认导入后的混合列表](index.html#34-imported-eight) | 布局重新排列，不缩小 PC SVG |
| 35 返回创建页 · 新列表保存与复用 | [导入后返回创建页](index.html#35-create-after-import) | 布局重新排列，不缩小 PC SVG |
| 36 接收实时串流 · 本机观看控制 | [接收端：实时观看](index.html#36-receiver-live) | 布局重新排列，不缩小 PC SVG |
| 37 监控布局预设 · 保存与加载 | [监控布局预设](index.html#37-monitor-presets) | 布局重新排列，不缩小 PC SVG |
| 38 实时画面沉浸全屏 · 无文件时间轴 | [实时画面全屏](index.html#38-live-fullscreen) | 布局重新排列，不缩小 PC SVG |
| 39 监控方阵沉浸全屏 · 退出恢复布局 | [监控方阵全屏](index.html#39-monitor-fullscreen) | 布局重新排列，不缩小 PC SVG |
| 40 批量踢出确认 · 不改变可见性 | [批量踢出接收端：确认](index.html#40-kick-all) | 布局重新排列，不缩小 PC SVG |
| 41 单个设备踢出确认 | [踢出单个接收端：确认](index.html#41-kick-one) | 布局重新排列，不缩小 PC SVG |

## 窄屏增加的独立页

- [首页：传输记录与草稿](index.html#m-home-records)：对应 PC 22。
- [首页：协同编辑与草稿](index.html#m-home-editor)：对应 PC 22。
- [发起端：查看播放列表](index.html#m-owner-playlist)：对应 PC 06。
- [发起端：查看观看者状态](index.html#m-owner-viewers)：对应 PC 06。
- [监控清单与添加订阅台](index.html#m-monitor-list)：对应 PC 08。
- [监控：单画面放大](index.html#m-monitor-focus)：对应 PC 08。
- [已导入资源：独立预览](index.html#m-resource-preview)：对应 PC 05。
- [选择串流来源类型](index.html#m-source-types)：对应 PC 03。
- [保存模板与复用入口](index.html#m-templates)：对应 PC 03。
- [音频台：播放与本机音频](index.html#m-media-audio)：对应 PC 31。
- [图片台：预览与上下切换](index.html#m-media-image)：对应 PC 31。
- [Markdown 台：阅读](index.html#m-media-markdown)：对应 PC 31。
- [TXT 台：阅读](index.html#m-media-txt)：对应 PC 31。
- [跨渠道待导入清单](index.html#m-import-review)：对应 PC 04。

## 源文件

- <code>prototype.css</code>：白色与中性灰视觉、窄屏 / 横屏 / 较宽设备排版。
- <code>prototype.js</code>：演示页面和本地交互状态，不调用项目接口。
- <code>catalog.json</code>：PC 与移动页对应关系。
- <code>../script2gen/streaming-console-v3-mobile-build.cjs</code>：生成目录、原浏览页、说明与 PNG。
- <code>../script2gen/streaming-console-v3-gallery.cjs</code>：原 v3 浏览页的 PC / 移动模式。

所有产品内容是本地演示。原应用代码、PC SVG / PNG 与原有 <code>info.txt</code> 均不在本次修改范围内。
