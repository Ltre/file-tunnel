研究一下新需求： 装好PWA的两台设备用NFC碰一碰，即可进入同一个隧道（选隧道策略1：优先选择两台设备都曾加入过的隧道list，再在这个list里选择最近使用的一个；选隧道策略2：设备A正开着某个隧道，设备B什么都没开，A和B相碰，设备B自动打开A所在的隧道；选隧道策略3：设备A通过一个按钮进入到NFC寻找模式界面，不论设备B有没有打开任何页面，都以A的隧道为准。


能做，但要把需求拆成两种版本：

```text
PWA 版：能做“碰 NFC 标签进入同一隧道”，不能做真正“两台手机互碰直接交换”。
原生 App / Android 壳版：可以进一步研究“手机 A 模拟 NFC 卡、手机 B 读取”的碰一碰体验。
```

核心限制是：**Web NFC 当前只面向 NDEF 标签读写，不支持低层 NFC I/O、手机对手机 Peer-to-Peer，也不支持 Host-based Card Emulation。** Chrome 官方文档明确写到 Web NFC 的当前范围限制在 NDEF；Peer-to-Peer 和 HCE 不支持。([Chrome for Developers][1]) MDN 也标注 Web NFC 不是 Baseline，属于实验性能力，并且只支持通过 NDEF 消息和兼容 NFC 标签交换数据。([developer.mozilla.org][2])

所以你说的“三种策略”可以实现，但**不是纯粹靠两台 PWA 手机互碰实现**。更现实的设计是：

> NFC 只负责传递一个极小的“一次性碰一碰邀请 token / URL”，真正的设备配对、隧道选择、权限确认、历史隧道交集判断，都交给服务端完成。

---

# 一、先判断三种策略的可行性

## 策略 1：优先选择两台设备都曾加入过的隧道

这个可以做，而且很适合 file-tunnel。

逻辑是：

```text
A 设备进入 NFC 配对流程
B 设备也进入 NFC 配对流程
服务端拿到 A/B 的 deviceId
查 A/B 都曾加入过的 tunnelIds
取交集
按 lastVisitedAt / lastActiveAt 排序
选择最近一个
双方进入该隧道
```

但要注意：**不要把两台设备的历史隧道列表直接写进 NFC payload**。NFC payload 应该只放一次性 token，例如：

```json
{
  "type": "file-tunnel-nfc-pair",
  "pairId": "p_xxx",
  "nonce": "xxx",
  "expiresAt": 1760000000000
}
```

真正的历史隧道交集由服务端查。

这样更安全，也避免 NFC 被旁边设备扫到后泄露用户历史隧道。

---

## 策略 2：A 正开着某个隧道，B 什么都没开，A/B 相碰，B 自动打开 A 所在隧道

**纯 PWA 不能做到“两台手机互碰，B 直接读到 A 的隧道”。**

原因是：Web NFC 里的网页只能读写 NFC 标签；网页本身不能把手机模拟成 NFC 标签给另一台手机读取。Chrome 官方文档写明 Web NFC 不支持 Peer-to-Peer 和 HCE。([Chrome for Developers][1])

但可以做一个近似体验：

```text
A 打开隧道页
A 点击“碰一碰邀请”
系统生成一次性邀请链接
A 把这个邀请写入一张 NFC 标签/贴纸
B 碰 NFC 标签
B 打开 PWA 并进入 A 当前隧道
```

或者：

```text
A 打开隧道页
A 点击“碰一碰邀请”
A 显示 QR + NFC 写入模式
B 扫 QR / 碰标签
B 进入 A 当前隧道
```

如果你一定要“手机 A 和手机 B 背靠背一碰”，那就不是 PWA 级别，而是 Android 原生 App / TWA + 原生 NFC 模块的问题。

---

## 策略 3：A 通过按钮进入 NFC 寻找模式，不论 B 有没有打开页面，都以 A 的隧道为准

纯 PWA 也做不到“不论 B 有没有打开任何页面，两台手机碰一下，B 自动读取 A”。

Web NFC 需要页面可见、用户授权、屏幕亮起、手机解锁，并且 NFC 操作要由用户手势触发；Chrome 文档写明 `scan()` / `write()` 需要用户手势和权限，页面还必须可见，屏幕关闭或设备锁定时 NFC 访问会被阻止。([Chrome for Developers][1])

但可以拆成两个版本。

### PWA 可实现版本

```text
A 进入 NFC 寻找模式
A 写入 NFC 标签：当前隧道一次性邀请
B 碰这张标签
B 自动打开链接 / PWA
B 加入 A 当前隧道
```

这能做到“B 不需要提前打开页面”，但前提是 **B 碰的是 NFC 标签，不是 A 手机**。

### 原生 App 可探索版本

```text
A 原生 App 进入 NFC 寻找模式
A 通过 HCE / Reader Mode / Nearby 组合暴露邀请
B 原生 App 或系统 NFC 读取
B 打开并加入 A 当前隧道
```

这才接近你说的“手机碰手机”。

---

# 二、PWA 版最推荐的落地方案：NFC 标签作为“隧道触发器”

我建议第一版不要死磕手机对手机 NFC，而是做：

> **NFC 标签 / 贴纸 = 隧道入口实体化。**

这很符合 file-tunnel 的“世界藤壶”定位：把一个隧道暗号钉到现实世界里。

## 典型场景

```text
桌上一张 NFC 标签：家庭隧道
电脑旁一张 NFC 标签：电脑收件箱
公司工位一张 NFC 标签：项目隧道
临时会议一张 NFC 标签：本次会议资料隧道
```

用户拿手机一碰，就进入对应隧道。

这比两台手机互碰更容易稳定落地，而且用户体验也很自然。

---

# 三、NFC Payload 设计

不要直接写裸隧道 ID，更不要写长期有效暗号。建议写一次性邀请 URL。

例如：

```text
https://your-domain.com/nfc?v=1&t=nfc_invite_xxx
```

或者 NDEF 自定义 MIME：

```json
{
  "type": "application/vnd.file-tunnel.nfc+json",
  "version": 1,
  "inviteToken": "nfc_invite_xxx",
  "mode": "join-current-tunnel",
  "expiresAt": 1760000000000
}
```

服务端保存：

```js
NfcInvite {
  token,
  issuerDeviceId,
  issuerTunnelId,
  strategy: 'current-tunnel' | 'mutual-recent' | 'select-on-server',
  expiresAt,
  maxUses,
  usedByDeviceIds,
  requireConfirm,
  createdAt
}
```

这样 NFC 标签被别人扫到，也只能拿到短期 token，不会泄露永久隧道暗号。

---

# 四、三种选隧道策略的产品化设计

## 策略 1：共同历史优先

适合两台设备都是用户自己的设备，或者双方曾经一起用过多个隧道。

流程：

```text
A/B 都碰同一个 NFC 入口
服务端识别两个 deviceId
查共同加入过的隧道
按最近使用排序
自动进入最近共同隧道
```

伪代码：

```js
function selectTunnelByMutualHistory(deviceA, deviceB) {
  const tunnelsA = getDeviceTunnelHistory(deviceA);
  const tunnelsB = getDeviceTunnelHistory(deviceB);

  const common = intersectByTunnelId(tunnelsA, tunnelsB);

  if (common.length > 0) {
    return common.sort((x, y) => {
      return Math.max(y.aLastSeen, y.bLastSeen, y.lastActivity)
           - Math.max(x.aLastSeen, x.bLastSeen, x.lastActivity);
    })[0];
  }

  return null;
}
```

如果没有共同历史：

```text
没有找到共同隧道
[加入 A 当前隧道]
[创建临时隧道]
[输入暗号]
```

---

## 策略 2：A 当前隧道优先

适合 A 正在一个隧道里，想让 B 进来。

A 点击：

```text
碰一碰邀请
```

生成：

```js
NfcInvite {
  strategy: 'current-tunnel',
  issuerTunnelId: currentTunnelId,
  requireConfirm: true,
  expiresAt: now + 2 * 60 * 1000
}
```

B 读到后：

```text
Ltre-PC 邀请你加入隧道 ABC12
该隧道当前有 2 台设备在线
[加入] [拒绝]
```

注意：**不要完全无感自动加入**，至少第一次要确认。否则别人拿一个恶意 NFC 标签就能把用户拉进未知隧道。

---

## 策略 3：A 的 NFC 寻找模式强制优先

适合 A 很明确要“以我当前隧道为准”。

A 进入：

```text
NFC 寻找模式
```

UI：

```text
正在等待附近设备碰一碰

当前隧道：ABC12
有效时间：2 分钟
允许加入：一次 / 多次
加入方式：碰 NFC 标签 / 扫二维码 / 输入短码

[写入 NFC 标签]
[显示二维码]
[取消]
```

这里的关键是：PWA 版里 A 只能**写入 NFC 标签**或显示 QR；不能把 A 手机自己变成可读 NFC 标签。

如果未来做 Android App，可以把这个界面保留，只是底层从“写标签”升级为“手机 HCE/原生 NFC”。

---

# 五、产品上要同时提供 NFC + QR + 短码

NFC 兼容性有限，不应该让它成为唯一入口。

建议这个功能叫：

```text
碰一碰加入
```

但页面里提供三种等价入口：

```text
碰 NFC
扫二维码
输入暗号
```

也就是：

```text
A 发起邀请
↓
生成同一个 inviteToken
↓
同时展示：
  - NFC 写入
  - QR 码
  - 5 位短码
  - 分享链接
```

这样在不支持 NFC 的 iPhone / 桌面 / 某些浏览器上也能走 QR 或短码。

---

# 六、兼容性判断

## Android Chrome / Android PWA

可作为第一目标。

Chrome 官方文档写到 Web NFC 已在 Chrome 89 for Android 发布，可以读写 NFC 标签；但它限定在 Chrome for Android 的能力范围内。([Chrome for Developers][1])

可做：

```text
读取 NDEF 标签
写入 NDEF 标签
读取 URL / text / MIME record
通过 HTTPS PWA 处理 invite URL
```

不可做：

```text
手机 A 作为 NFC 标签让手机 B 读取
手机对手机 Peer-to-Peer
后台无页面可见时 NFC 监听
锁屏状态自动处理 NFC
```

## iPhone / iOS PWA

不要把它作为 NFC 方案主力。iOS Safari/PWA 对 Web NFC 支持并不等同 Android Chrome；MDN 也明确提示 Web NFC 不是广泛可用能力。([developer.mozilla.org][2])

iPhone 上建议默认走：

```text
二维码
短码
分享链接
系统分享
```

如果以后做原生 iOS App，再研究 Core NFC 能力，但 iOS 对 NFC 写入、后台触发、标签类型也有自己的限制。

---

# 七、技术实现建议

## 1. 前端能力检测

```js
function isWebNfcSupported() {
  return 'NDEFReader' in window;
}
```

Chrome 文档也推荐通过 `NDEFReader` 做能力检测，但同时说明 `NDEFReader` 存在只代表浏览器支持，不代表设备一定有 NFC 硬件；实际调用仍可能失败。([Chrome for Developers][1])

UI：

```text
支持 NFC：
  显示“碰一碰加入”

不支持 NFC：
  显示“当前浏览器不支持 NFC，请使用二维码或短码”
```

---

## 2. NFC 寻找模式

```js
async function writeTunnelInviteToNfcTag(inviteUrl) {
  const ndef = new NDEFReader();

  await ndef.write({
    records: [
      { recordType: 'url', data: inviteUrl }
    ]
  });
}
```

注意：`write()` 必须由用户点击触发。Chrome 文档写明写入 NFC 标签需要用户手势、权限、手机支持 NFC、NFC 已启用，并且用户要实际触碰 NFC 标签。([Chrome for Developers][1])

---

## 3. NFC 读取模式

```js
async function startNfcScan() {
  const ndef = new NDEFReader();
  await ndef.scan();

  ndef.onreading = event => {
    for (const record of event.message.records) {
      if (record.recordType === 'url') {
        const url = decodeNfcUrl(record);
        handleNfcInviteUrl(url);
      }
    }
  };
}
```

读取也需要用户手势和权限。页面不可见时 NFC 操作会被暂停，页面恢复可见后才恢复。([Chrome for Developers][1])

---

## 4. 服务端接口

新增：

```http
POST /api/nfc/invites
```

创建邀请：

```js
{
  strategy: 'current-tunnel',
  tunnelId,
  issuerDeviceId,
  expiresInMs: 120000,
  maxUses: 1
}
```

返回：

```js
{
  inviteToken,
  inviteUrl,
  expiresAt
}
```

解析邀请：

```http
POST /api/nfc/resolve
```

请求：

```js
{
  inviteToken,
  deviceId,
  currentTunnelId,
  deviceTunnelHistoryHash
}
```

返回：

```js
{
  action: 'join-tunnel',
  tunnelId,
  tunnelName,
  requireConfirm,
  reason: 'issuer-current-tunnel'
}
```

或者：

```js
{
  action: 'choose-tunnel',
  candidates: [
    {
      tunnelId,
      name,
      lastUsedAt,
      reason: 'mutual-history'
    }
  ]
}
```

---

# 八、状态机建议

```text
idle
  ↓
nfc-prepare
  ↓
nfc-writing / nfc-scanning
  ↓
nfc-touched
  ↓
resolving-invite
  ↓
confirm-join
  ↓
joining-tunnel
  ↓
joined
```

错误状态：

```text
nfc-not-supported
nfc-permission-denied
nfc-disabled
nfc-page-hidden
nfc-tag-not-ndef
nfc-write-failed
invite-expired
invite-used
tunnel-not-found
```

这些错误提示要写得像用户能理解的话：

```text
当前浏览器不支持 NFC，请使用二维码或短码。
请打开手机 NFC 后重试。
请保持页面在前台，再碰 NFC 标签。
这个碰一碰邀请已过期，请重新生成。
```

---

# 九、安全细节

NFC 的“物理接近”不等于完全安全。NFC 标签可能被别人读取、复制、覆盖。

所以：

## 1. token 必须短期有效

```text
默认 2 分钟过期
一次性使用
可手动刷新
```

## 2. 第一次加入必须确认

```text
Ltre-PC 邀请你加入隧道 ABC12
[加入] [拒绝]
```

不要直接无提示加入。

## 3. token 绑定发起设备

```js
{
  inviteToken,
  issuerDeviceId,
  issuerTunnelId,
  issuedAt,
  expiresAt
}
```

## 4. 可撤销

A 取消 NFC 寻找模式时，服务端立即作废 token。

## 5. 标签写入要区分临时/永久

如果用户写到实体 NFC 标签：

```text
临时邀请：2 分钟有效
永久入口：长期指向某个固定隧道/路由页
```

永久入口不要直接包含敏感 token，而应包含：

```text
https://your-domain.com/nfc/static/<tagId>
```

服务端再判断这个 tagId 是否仍有效。

---

# 十、最终建议的产品方案

我建议你把这个需求定成：

> **NFC 碰一碰加入隧道：Android Chrome/PWA 支持碰 NFC 标签进入隧道；不支持 NFC 的设备自动降级为二维码和短码；未来 Android 原生版再支持手机碰手机。**

第一版功能：

```text
1. 隧道页增加“碰一碰邀请”按钮。
2. 点击后生成短期 inviteToken。
3. 同时显示：
   - 写入 NFC 标签
   - 二维码
   - 短码
   - 分享链接
4. Android Chrome 支持写入/读取 NFC 标签。
5. B 碰标签后打开 /nfc?t=xxx。
6. 服务端解析 token。
7. 如果 A 当前有隧道，B 加入 A 当前隧道。
8. 如果两台设备都有共同历史，优先进入最近共同隧道。
9. 如果没有共同历史，提示创建临时隧道或输入暗号。
```

第二版：

```text
1. NFC 标签永久绑定某个隧道入口。
2. 支持“家庭隧道标签”“电脑收件箱标签”“会议资料标签”。
3. 支持 admin 管理 NFC 标签。
4. 支持标签丢失后撤销。
```

第三版：

```text
1. Android 原生壳支持更强 NFC。
2. 探索 HCE / Reader Mode。
3. 做真正的手机碰手机邀请。
```

---

# 十一、对你三条策略的最终结论

```text
策略 1：两台设备共同历史隧道优先
可以做，建议由服务端根据 deviceId 历史交集选择。

策略 2：A 正开隧道，B 没开，碰一下 B 进入 A 隧道
纯 PWA 手机碰手机做不到；PWA + NFC 标签可以做到；原生 Android 版可进一步研究。

策略 3：A 进入 NFC 寻找模式，不管 B 有没有打开页面都以 A 隧道为准
纯 PWA 只能通过 NFC 标签/二维码/短码实现；真正 B 无页面也能被 A 手机唤起，需要原生能力。
```

所以这个需求**值得做**，但第一版应该避免承诺“PWA 手机互碰”。更准确的产品表达是：

> **碰 NFC 标签加入隧道；手机碰手机留给 Android 原生增强版。**

[1]: https://developer.chrome.com/docs/capabilities/nfc "Interact with NFC devices on Chrome for Android  |  Capabilities  |  Chrome for Developers"
[2]: https://developer.mozilla.org/en-US/docs/Web/API/Web_NFC_API "Web NFC API - Web APIs | MDN"
