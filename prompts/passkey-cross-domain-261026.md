# 同一系统多域名复用 Passkey 的调查与分析

对应需求：`编号261026-2` 第 7 项。分析日期：2026-10-26。

本文从[开发日志](../docs/devlog/dev-2610-streaming-console.md)中“第 7 项：多域名 Passkey 调查与处理建议（仅分析）”整理而来。源码行为、官方资料及调查结果均为上一轮记录，本次仅整理文档，没有重新调查兼容性或修改认证代码。

## 需求与已知现象

同一套系统增加另一个访问域名后，在新域名下使用原账号名进行 Passkey 登录，提示：

```text
该账号尚未在此域名注册 Passkey [PASSKEY_ACCOUNT_NOT_FOUND]
```

用户期望同一系统通过多个域名提供服务时，仍能用同一账号名和原来的同一个 Passkey 登录，不因业务访问域名变化而被要求重新注册。

本项先调查 WebAuthn 的域名约束、客户端密码管理器的保存与匹配规则、符合标准的跨域复用机制及兼容性，并核对 Google、GitHub 的实际情况；只形成分析和处理建议，不修改代码。

## 上一轮源码核对结果

`disk-auth.passkeyOptions` 按账号名找到同一用户后，要求凭据 `rpID` 精确等于服务端识别的 `Origin.hostname`，生成的 RP ID 也取该 hostname；不匹配就在 options 阶段返回 `PASSKEY_ACCOUNT_NOT_FOUND`，尚未调起客户端验证。

verify 同时验证注册时保存的 RP ID、挑战及 Origin。

因此，这个提示不能直接证明账号不存在，也不能证明客户端密码管理器已经查找过凭据但没有找到。上一轮没有修改这些代码或真实凭据。

## Origin、RP ID 与浏览器检查

WebAuthn 的 Origin 与 RP ID 是不同概念：

- Origin 含协议、主机及端口。客户端签名数据携带实际调用来源，服务端应按受信来源核验。
- RP ID 是域名范围，不含协议/端口。凭据绑定 RP ID，不能仅凭相同账号名搬到另一个 RP ID。
- 浏览器在调起认证器之前，会校验调用域名能否使用指定 RP ID，并非服务端单方面允许就够。

以上约束见 [W3C WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/)。

例如，`a.example.com` 与 `b.example.com` 可以使用共同的 `example.com` RP ID，但已经绑定 `a.example.com` 的旧凭据，不能只修改数据库字段就变成 `example.com` 凭据。不同可注册域名更不能直接互换；系统使用多个域名与凭据安全作用域是两件事。

## Related Origin Requests：关联域名复用机制

Related Origin Requests（ROR）允许受控的不同来源使用同一个 RP ID：

- 原 RP 域名通过 HTTPS 的 `/.well-known/webauthn` 列明允许来源。
- B 的请求仍用 A 的 RP ID。
- 服务端仍核验实际 B Origin，而非伪装为 A。
- 浏览器/凭据提供方需要实际支持。

仅增加 CORS、改密码管理器显示分组，或让服务端按同账号返回所有 key，均不能绕过客户端的作用域校验。[Google/Chrome 说明](https://developer.chrome.com/blog/passkeys-updates-chrome-129)、[ROR 配置及浏览器支持说明](https://web.dev/articles/webauthn-related-origin-requests)

## 密码管理器的保存、分组与使用范围

Google 密码管理器保存/同步凭据，并不意味着同名账号的密钥可跨任意网站选取。

应区分密码自动填充的关联规则、界面分组、Passkey 的 RP ID、浏览器 ROR，以及原生应用的 Digital Asset Links。Google 官方提供跨网站/Android 应用关联配置示例，但不能据此宣称用户的具体国产浏览器已支持。[Google 凭据共享实验](https://codelabs.developers.google.com/seamless-credential-sharing)

因此，界面上按域名分组与凭据实际可被哪些来源调用，不能混为一个问题。

## Google、GitHub 调查结果及证据限制

Google 已公开提供 ROR 能力、配置示例及密码管理器配合示例；这证明存在标准化复用方式，不足以确认 Google 账号所有生产域名都直接采用该方案。

GitHub 官方资料确认域名绑定、同步和跨设备认证；上一轮没有查到足以证实 `github.com` 与另一不相关域名共享同一 Passkey 的官方说明。[GitHub 官方资料](https://docs.github.com/en/authentication/authenticating-with-a-passkey/about-passkeys)

上一轮对 `github.com/.well-known/webauthn` 的单次公开读取返回 404，对 Google 对应地址的工具读取不可用；这些结果不能推出它们所有域名都不使用 ROR。

## 上一轮处理建议

先固定可持续拥有的 RP ID，保留已有凭据的原 RP ID；为明确受信的新域名评估 ROR，并验证目标浏览器/密码管理器。

若客户端不支持，可评估统一认证域名的独立登录窗口及一次性回执，让业务页留在原地。它依然使用原 RP 下的同一凭据，但涉及跨域回执和各域会话签发，不能复用同源 Cookie 假装完成。

旧域名失去控制或无法提供所需认证/声明时，不能承诺旧凭据无条件迁移。禁止为了兼容而移除 Origin/RP ID 检查，或信任任意请求主机作为跨域授权。

## 结论与实现边界

产品不必限制为单一业务域名，但“添加任意新域名即自动复用旧凭据”不是当前代码或标准的无条件能力。

上一轮仅记录分析建议，没有添加配置、ROR 端点、认证窗口或修改凭据绑定。本次仅整理已有分析，没有新增实现、兼容性验证或测试结论。
