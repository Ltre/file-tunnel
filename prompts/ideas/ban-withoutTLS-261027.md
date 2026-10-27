# 公网入口限制非 TLS 访问，同时保留 Cloudflare HTTP 回源

需求：`编号261027-1` 第 4 项。分析日期：2026-10-27。

本条只分析，没有修改应用的 HTTP、Socket.IO、代理信任或部署策略，也没有调整正式 Cloudflare 配置。

## 目标与边界

公网用户只能通过 HTTPS/WSS 使用系统；保留本地电脑及局域网设备通过 HTTP 调试、访问的能力。Cloudflare 已验证的 HTTPS 访客请求，即便最后一段通过 HTTP 回源，也应正常处理。

这里必须分开两段连接：

```text
访客 -- HTTPS --> Cloudflare -- HTTP --> Nginx/Node
```

这种拓扑只保证第一段 TLS，不是端到端 TLS。Cloudflare Flexible 模式正是 HTTPS 访客、HTTP 回源的模式；源站无条件将收到的 HTTP 请求重定向为 HTTPS，会产生循环。[Cloudflare Flexible](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/flexible/)

本需求允许上述回源，所以不能实现为“Node socket 未加密就全部拒绝”。

## 当前源码与部署模板核对

- [server.js](../../server.js) 使用 `http.createServer(app)`，监听 `0.0.0.0`。Node 本身没有在这个入口终止 TLS。当前未设置统一的 Express `trust proxy` 策略，也没有覆盖所有请求的公网明文拦截。
- 同文件的 `getTelegramPublicOrigin` 等逻辑会读取 `X-Forwarded-Proto`、`X-Forwarded-Host`。这些是既有 URL/登录处理，不能视作已经完成可信代理身份认证，更不能直接当作新增安全门禁的依据。
- [Nginx 模板](../../tools/deploy/templates/nginx.conf.tpl) 在普通请求和 `/socket.io/` 两处均设置 `X-Forwarded-Proto $scheme`。若 Cloudflare 通过 HTTP 连入 Nginx，`$scheme` 为 `http`，会覆盖 Cloudflare 原来表达的访客协议。`$scheme` 表示这一跳请求的协议，并不会自动还原 CDN 前的访客协议。[Nginx 变量说明](https://nginx.org/en/docs/http/ngx_http_core_module.html#var_scheme)
- Node 的 Socket.IO 绑定同一个 HTTP Server，具有独立的 Engine.IO 请求及 Upgrade 入口。只增加普通页面/API 的 Express 中间件，不足以证明 WebSocket 升级也已受到同一门禁保护。
- 当前 Socket.IO 配置中的 CORS 来源检查也不等于 TLS 门禁；官方说明 CORS 只约束浏览器，且在 Socket.IO 中只适用于 HTTP long-polling，不适用于 WebSocket 连接。当前代码还允许没有 Origin 的请求，不能用 Origin 头替代真实协议或代理来源判断。[Socket.IO CORS 边界](https://socket.io/docs/v4/handling-cors/)
- 上述源码核对不代表正式服务器一定使用此模板。实际 Cloudflare SSL 模式、Nginx 配置、源站防火墙、是否使用 cloudflared，以及代理链层数尚未取得，不能宣称生产环境已具备可信回源链。

## 协议头只能在可信链中使用

Cloudflare 文档说明 `X-Forwarded-Proto` 表达访客连接 Cloudflare 时使用的协议，并会覆盖访客自行传入的该头；`CF-Visitor` 也包含 scheme 信息。该语义只在请求确实经由受信 Cloudflare 链路时成立，任意客户端直连 Node 仍可伪造同名头。[Cloudflare 请求头](https://developers.cloudflare.com/fundamentals/reference/http-headers/)

后续实现应按实际拓扑确定信任来源：

1. Cloudflare 直接回源：校验连接对端属于当前有效 Cloudflare 出口地址范围，同时限制可用业务 Host；按已验证的访客协议决定是否允许。仅有 `CF-Ray`、`CF-Connecting-IP`、`CF-Visitor` 等头不等于来源可信。
2. Cloudflare → 自有 Nginx → Node：Nginx 验证上游来源，规范化访客协议并清理可伪造头；Node 只信任明确的 Nginx 地址/套接字，不能信任所有内网 IP。
3. cloudflared：需要确认受控本地连接与对应入口配置，不能把 Cloudflare 公网地址表机械应用于本地 Tunnel 连接。它由本地连接器主动建立出站连接，连接器到本机业务服务这一跳又可以是 HTTP，不能把所有回环 HTTP 都当成经此连接器认证的流量。[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)
4. 其它直接 HTTPS 反向代理：代理必须清理并重建协议头，Node 仅信任该受控代理。

Express 官方要求 `trust proxy` 与真实拓扑一致，并警告代理若不清理 `X-Forwarded-*`，客户端可以提供任意值。不能简单设为 `true`，也不能在路径长度不固定时只信任固定跳数。[Express 代理部署](https://expressjs.com/en/guide/behind-proxies/)

Cloudflare 官方建议源站允许其回源地址，同时限制绕过 CDN 的访问；地址范围需要维护。该范围由多个站点共享，因此“来自 Cloudflare”不替代业务 Host、应用身份和必要的回源身份限制。[Cloudflare IP 地址](https://developers.cloudflare.com/fundamentals/concepts/cloudflare-ip-addresses/)、[源站保护](https://developers.cloudflare.com/fundamentals/security/protect-your-origin-server/)

保留 HTTP 回源时，不能把 Authenticated Origin Pulls 当作这条明文回源的认证手段：该机制使用 mTLS，在 Off／Flexible 模式下不生效。这里不要求改变用户明确允许的 HTTP 回源方式，但必须如实区分来源地址限制、业务身份校验与传输加密各自能证明的事情。[Cloudflare AOP](https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/)、[Flexible 限制](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/flexible/)

## 本地和公网的判定

“本地局域网 IP/主机名例外”不能仅检查用户提供的 Host 是否以 `192.168` 开头、是否无点号，或请求的最后一个对端是否是 `127.0.0.1`。公网请求经过本机 Nginx 时，Node 看到的对端同样可能是本地地址；公网客户端也可以伪造 Host。

建议本地例外同时满足：真实直连来源属于明确允许的回环/局域网范围，且请求目标是配置允许的本地 IP/主机名。需要按 IP 解析器处理 IPv4、IPv4-mapped IPv6、IPv6 回环及 ULA，不使用字符串前缀猜测。不能把所有 `172.*`、公网 IPv6 或任意 `.local` 名称自动当作可信本地访问。

经代理的请求先验证代理链，再按可信的访客身份与入口判定，不因为最后一跳是内网地址而获得“本地”豁免。公网域名即使在局域网解析到私网地址，也不能仅凭 Host 解析结果放宽访问策略。

## 允许与拒绝矩阵

| 场景 | 预期结果 |
| --- | --- |
| 回环/允许的局域网设备直接访问允许的本地 HTTP 地址 | 保留访问 |
| 公网用户直接通过 HTTP 访问业务域名或源站 IP | 拒绝明文业务访问 |
| 公网用户伪造本地主机名或 `X-Forwarded-Proto: https` | 不获得例外 |
| 可信 TLS 代理传入 HTTPS 访客请求 | 允许 |
| 已验证的 Cloudflare 链路，访客 HTTPS、回源 HTTP | 允许，不发生 HTTPS 重定向循环 |
| 已验证的 Cloudflare 链路，访客 HTTP | 边缘升级或阻止；不得直接处理明文业务请求 |
| 不可信来源仅伪造 Cloudflare 头 | 拒绝例外 |
| Socket.IO polling/Upgrade 使用明文公网入口 | 与普通请求执行同一策略 |
| 受控 cloudflared 本地回源 | 依据已验证入口元信息处理，不按本地豁免盲目放行 |

## 后续实施位置与建议

优先在公网最外层入口完成访客 HTTPS 策略，在回源入口建立可信边界。Cloudflare 的 Always Use HTTPS 可以把访客 HTTP 重定向到 HTTPS，且不改变 HTTP 回源模式；这属于升级，不是“拒绝连接”。如果“ban”要求严格阻止，需选择对应的边缘拒绝规则，而非将重定向当成等价行为。[Cloudflare Always Use HTTPS](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/)

Node 如增加兜底，应使用一个统一、可测试的连接分类函数，同时覆盖页面、API、文件/Range、NDJSON 流以及 Engine.IO polling/Upgrade。Socket.IO 官方从 4.6.0 起提供 `io.engine.use`，会在底层 HTTP 请求与升级请求上执行中间件。本次本地依赖为 Socket.IO 4.8.3，实际 Engine.IO 源码的 `handleRequest` 和 `handleUpgrade` 都调用 `_applyMiddlewares`，符合这个机制；这只证明可用的接入位置，实施后仍需完整握手回归，不能只保护已建立后的业务事件。[Socket.IO 中间件](https://socket.io/docs/v4/middlewares/#compatibility-with-express-middleware)

不要全局改变现有 Origin、登录 Cookie 或 Passkey 校验来“兼容”这一策略；不要将非 TLS 业务请求自动重放为带正文的 HTTPS 请求。对 API/上传的拒绝要给出明确协议错误，重试必须由原业务流程判断。HSTS 可在公网 HTTPS 入口进一步评估，但不会替代首次明文连接的拦截，也不应无差别应用于局域网开发地址。

## 实施前需核对及验证

尚需核对真实代理链、所有业务域名、本地允许地址/主机名、Cloudflare SSL 模式及回源限制。无法仅从本仓库确认这些部署事实。

实现前应建立上表的 HTTP 与 WebSocket 测试，并额外验证：Cloudflare HTTP 回源不循环、两段 `/socket.io/` 协议头一致、伪造头和公网直连无法绕过、本地设备仍可进入隧道、上传及流媒体连接不受误拦截。正式部署再用真实 Cloudflare 访问验证；本次未执行这些线上验证。

结论：可以同时实现“公网访客必须 TLS”和“允许 Cloudflare HTTP 回源”，前提是验证代理来源并保留访客原始协议，不能单凭 Node 最后一跳的 HTTP 或任意请求头下判断。本轮保持分析状态，没有实施拦截。
