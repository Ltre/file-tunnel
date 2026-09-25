# 测试体系、人工验收与历史回归索引

> **源码基线 Commit**：`b422e438fe50f78fdacd84ac1dff34a30a3d43ba`  
> **文档更新时间**：`2026-09-26`

## 1. 为什么本项目尤其依赖回归资料

Drop2Tunnel 的困难不是“有没有自动测试”，而是一个局部正确修改经常改变：

- 网络时序；
-浏览器缓存；
- Service Worker；
- history；
- pointer/touch；
- P2P/Relay；
- Telegram 真实 API；
- yt-dlp/ffmpeg 外部行为。

Git 历史里大量存在：

- `DEBUG`
- `WRONGCODE`
- `有BUG`
- `看似能用`
- `先固定代码`
- `待线上测试`

这些提交非常有价值：它们是已知错误方案的档案。

后续 AI 不应只搜索“最后谁改了这个函数”，还应看附近提交为什么被后续推翻。

## 2. 事实优先级

整理/开发时建议：

1. **当前源码**：当前实现事实；
2. **最新人工验收**：真实用户环境是否成立；
3. **专项 regression test**；
4. **最新 Devlog**；
5. **最新 Prompt**；
6. **旧 Devlog/README/overview**；
7. **单个旧 Commit message**。

如果 Codex 某轮回答写“已修复”，但下一轮用户马上说“操你妈又复现了”，文档必须以“仍复现/后续再次修”为演进事实，不能停在前一轮自述。

## 3. 当前 tests 目录分类

### 3.1 P2P / file asset

- `p2p-connection-regression.test.cjs`
- `file-asset-audit-isolation.test.cjs`
- `history-startup-regression.test.cjs`

覆盖：

- signaling；
- Relay fallback；
- audit isolation；
- startup/history。

### 3.2 Infra store

- `infra-store-audit.test.cjs`
- `infra-store-write-batching.test.cjs`

用于保护：

> 审计持久化不能重新进入实时传输关键路径。

### 3.3 Telegram Drive

- `telegram-drive.test.cjs`
- `disk-api.test.cjs`
- `disk-client.test.cjs`
- `disk-directory-actions.test.cjs`
- `disk-followup.test.cjs`
- `disk-image-preview.test.cjs`
- `disk-part-cache.test.cjs`
- `disk-preview-history.test.cjs`
- `disk-sharing.test.cjs`
- `disk-step3.test.cjs`
- `disk-storage-regression.test.cjs`
- `control-center-drive.test.cjs`

### 3.4 Downloader

- `sns-download.test.cjs`
- `youtube-premium.test.cjs`
- `youtube-album-artist-regression.test.cjs`

### 3.5 Audio repair

- `audio-track-repair.test.cjs`
- `audio-track-repair-ui.test.cjs`

### 3.6 VClient

- `vclient-runtime.test.cjs`
- `vclient-shell-push.test.cjs`

### 3.7 Version feature regression

- `features-2608B.test.cjs`
- `features-2608C.test.cjs`
- `features-260916-2.test.cjs`
- `features-260917-1/2/3.test.cjs`
- `features-260918-1/2.test.cjs`
- `features-260921-1/2.test.cjs`
- `features-260922-1.test.cjs`
- `bugs-260914.test.cjs`

这些文件往往直接对应某一批用户验收 Bug，因此是“需求细节”的补充来源。

## 4. 自动测试不能证明的事情

### 4.1 真实 Telegram

Mock 很难完整模拟：

- Bot permission；
- private channel；
- file_id 生命周期；
- deleteMessage 时间限制；
- editMessageMedia；
- media group；
- Range proxy；
- Telegram preview thumbnail。

### 4.2 Android touch

Node/jsdom 静态断言不能证明：

- touch inertia；
- synthetic mouse event；
- bottom sheet；
- viewport；
- Android back；
- 宽屏平板。

### 4.3 WebRTC 网络环境

本机三个 tab 成功不代表：

- NAT；
- VPN；
- mobile network；
- proxy；
- Cloudflare；
- relay fallback。

### 4.4 CDN / Service Worker

本地 localhost 不能复现：

- CDN stale asset；
- Nginx header；
- production old tab；
- SW update controller race。

### 4.5 yt-dlp

外部站点会更新，格式/JS challenge/Cookie 结果随时间变化。

因此“测试通过”必须同时写清：

- unit/regression；
- browser manual；
- production；
- real external service；

到底验证了哪一层。

## 5. P2P 回归历史

### 5.1 2026-06 至 07

早期集中解决：

- multi-device history 不一致；
- editor image 丢失；
- large file progress；
- P2P/relay；
- multi-source；
- message fallback；
-强拉恢复。

### 5.2 2026-07 至 08

多次出现：

- P2P 传到 100% 后 Relay 再传一次；
- old attempt event；
- receiver close race；
- ICE candidate；
- VPN/proxy；
- retry storm。

其中 `0b8e4e18...` 一度被后续文档当作重要稳定传输对照基线。

修改文件传输时应阅读：

- `docs/other/TECH_CHALLENGES_OF_TRANSMISSION*.md`
- `docs/other/P2P_TRANSMISSION_NOTES-260812.md`
- `docs/devlog/dev-260713-file-transfer-strategy...`

## 6. Music player 回归历史

2026-07 初反复处理：

- queue drawer；
- current track；
- cover；
- automatic tail fill；
- history；
- minimize/close；
- queueOrder；
- refresh restore。

说明音乐播放器状态高度耦合，不适合用“重建 DOM 即重置状态”的方式改 UI。

## 7. 网盘回归历史

2026-08-30 以后，`docs/devlog/dev-2608C-features.md` 17-39 几乎连续都是网盘。

重点演进：

- OIDC；
- Passkey；
- third-party API；
- centered operation；
- directory tree；
- shares；
- admin review；
- logical multipart；
- browser→Node→Telegram pipeline；
- Range；
- cache；
- upload rollback；
- bottom menu；
- media preview；
- thumbnail；
- mobile gesture；
- JSON concurrency design。

因此“修一个网盘按钮”前往往值得搜索整个 17-39，而不是只看最后一个 section。

## 8. Web Workshop 回归历史

2026-09-16 起：

- 初始网页 ZIP；
- runtime；
- edit permission；
- existing-file update；
- stale cache；
- srcdoc/blob；
- external JS；
- malformed script；
- service worker takeover；
- package name；
- minimize；
- resource import。

典型调试方式：

> 同一个流程同时测试 new / existing update / copy 三条路径。

只测 new draft 非常容易漏掉 sourceFile / ownership / cache version Bug。

## 9. 人工验收标签

Prompt 里会出现：

- `【验收通过】`
- `【勉强验收通过】`
- 再次复现描述。

文档维护应记录这些标签。

例如 260924：

- 下载任务 → 转码：验收通过；
- web ZIP hide frame：验收通过；
- PC disk drag upload：验收通过；
- full timestamp：验收通过；
- three-column equal height：勉强验收；
- workshop resource import：验收通过。

这比“Codex 跑 291 test”更能说明 UI 是否达到用户预期。

## 10. 故障注入

对状态机类模块应主动加故障测试：

### File

- provider disconnect；
- P2P completion before relay cancel；
- relay late chunk；
- cache commit fail。

### Disk

- Telegram success + index commit fail；
- upload cancel；
- restart with staging manifest；
- directory move throw halfway；
- Range consumer abort。

### Web ZIP

- old Service Worker；
- Runtime mount verify fail；
- save revision race；
- publish update cache fail。

### Downloader

- yt-dlp killed；
- FFmpeg failed；
- task restart；
- cache deleted。

## 11. 测试命名

新测试最好按：

- module；
- exact regression；
- requirement ID

之一命名。

不要所有新问题继续塞进一个无限增长的 `features-2608C.test.cjs`；当前后续已经逐步采用日期编号文件，是更容易追溯的方式。

## 12. 文档更新规则

每次新的人工验收若推翻本文：

1. 更新对应模块文档；
2. 如果属于高风险 regression，更新本文；
3. 更新 `VERSION.md` 对应覆盖基线；
4. 保留旧需求演进说明，不要直接删到看不出为什么存在某段兼容代码。

## 13. 运行测试时的记录格式

建议开发日志明确：

```text
自动测试：
- node --test ... : N passed / M failed

语法：
- node --check ...

静态：
- git diff --check

浏览器：
- PC Chrome：通过 / 未执行
- Android：通过 / 未执行

真实外部：
- Telegram：通过 / 未执行
- yt-dlp：通过 / 未执行
```

不要用一句“测试通过”模糊所有层。

## 14. Git 提交也属于回归资料

用户习惯在复杂调试中频繁“先固定代码”，因此 Commit message 经常保留：

- 当前能用程度；
- 已知 Bug；
- 回退点。

AI 后续做 bisect/调研时，应把 commit title 中的这些自然语言作为线索，但最终仍要看 diff/源码和后续提交。
