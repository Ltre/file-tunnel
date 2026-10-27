# 荣耀 60 Pro 注册 Passkey 异常分析

对应需求：`编号261026-2` 第 9 项。分析日期：2026-10-26。

本文从[开发日志](../docs/devlog/dev-2610-streaming-console.md)中“第 9 项：荣耀 60 Pro 注册异常分析（仅分析）”整理而来。源码行为及调查结论均为上一轮记录，本次仅整理文档，没有修改认证代码或进行真机复测。

## 需求与已知现场

荣耀 60 Pro / Android 14 注册 Passkey 时出现以下提示：

```text
The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.
```

作为对照，三星国行 S10+ / Android 10 可以使用 Passkey。用户认为较新的 Android 14 设备反而无法注册，情况不符合预期，要求先分析原因，不修改代码。

具体浏览器/内核版本、选用的凭据提供方、屏幕锁、调用来源和原始 `DOMException.name` 均未提供。操作系统版本较高并不保证同一浏览器及凭据能力可用，不能归因于“国产机不支持”，也不能断言缺少 Google 服务。

## 上一轮核对的注册流程

前端先检查安全上下文、`PublicKeyCredential`、`navigator.credentials` 和 SDK，读取 `/options` 后调用 `startRegistration`，成功才向 `/verify` 提交。

服务端要求 HTTPS，注册选项的 `residentKey` 和 `userVerification` 均为 `required`，挑战与浏览器流程 Cookie 绑定。

源码中没有按荣耀型号禁用的分支。没有手机上的原始请求，不能确定失败发生于浏览器调起、认证器交互、返回凭据，还是服务端确认。

## 错误提示能够说明什么

`NotAllowedError` 是多种未完成情形可能使用的结果，包含超时/未获允许，不能仅据文案断言用户点了取消。WebAuthn 隐私要求本身也限制错误区分。[W3C 客户端隐私与注册流程](https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client)

因此，这段报错不能唯一定位根因，也不足以判断属于系统、浏览器、凭据提供方、用户交互或应用流程中的哪一个问题。

## 浏览器、系统与凭据提供方兼容性

Google 的支持说明将浏览器、系统与凭据提供方分开；Android 14 可选择第三方提供方，部分 OEM 环境存在差异。Google 密码管理器可用、Android 版本满足、网页存在 API，均不单独保证本次注册选项能完成。[Android/Chrome 官方支持说明](https://developers.google.com/identity/passkeys/supported-environments)

当前点击处理会异步读取 options 后再调 SDK；官方库资料存在浏览器手势及二维码注册的兼容注意事项。这是待核对方向，不是已经确认荣耀出现同一问题，也不意味着凡是 `await fetch` 都错误。[SimpleWebAuthn 13.3 文档](https://simplewebauthn.dev/docs/13.3.x/packages/browser)、[浏览器差异](https://simplewebauthn.dev/docs/advanced/browser-quirks)

## 上一轮提出的排查方向

后续排查按阶段留证：

- 核对同一 HTTPS Origin/证书，以及 options 中的 RP ID 和认证器要求。
- 分别记录 SDK 调用前、返回/拒绝及 verify 请求结果，区分失败阶段。
- 比较同设备不同浏览器/凭据提供方、同浏览器两台设备的表现。
- 记录时不收集私钥、挑战完整值或登录凭据。
- 仅能证明某项条件有问题后再调整，不能用降低用户验证要求来掩盖未知故障。

这些是上一轮的分析建议，尚未被真机证据证实为本次故障原因。

## 实现与验证边界

上一轮没有修改认证选项、`登录 / 移除账号` 对话框、服务器认证代码或 SDK，也没有在真实手机上执行注册。

结论是尚缺原现场证据，已有报错无法唯一定位根因。本次仅整理已有分析，没有新增实现或测试结论。
