【旧】
6、根据以下cloudflare TURN配置说明，为隧道P2P传输提供cloudflare TURN支持。

	```
	Cloudflare TURN 凭据


	Turn名称：   名称已脱敏已脱敏已脱敏已脱敏已脱敏名称
	Turn令牌ID：ID已脱敏已脱敏已脱敏已脱敏已脱敏已脱敏已脱敏ID
	API令牌： 令牌已脱敏已脱敏已脱敏已脱敏已脱敏已脱敏已脱敏令牌

	如何创建凭据
	为了给每个TURN用户生成短期凭据，应该在后端服务中使用 TURN令牌ID 和 API令牌 生成凭据。生成凭据需要调用API，如下所示：

	curl \
	-H "Authorization: Bearer 令牌已脱敏已脱敏已脱敏已脱敏已脱敏已脱敏已脱敏令牌" \
	-H "Content-Type: application/json" -d '{"ttl": 86400}' \
	https://rtc.live.cloudflare.com/v1/turn/keys/ID已脱敏已脱敏已脱敏已脱敏已脱敏已脱敏已脱敏ID/credentials/generate-ice-servers
	然后，可以将下方的 JSON 响应传递到您的前端应用程序，以在创建 RTCPeerConnection 时使用：

	{
	"iceServers": [
	   {
		 "urls": [
		   "stun:stun.cloudflare.com:3478",
		   "turn:turn.cloudflare.com:3478?transport=udp",
		   "turn:turn.cloudflare.com:3478?transport=tcp",
		   "turns:turn.cloudflare.com:5349?transport=tcp"
		 ],
		 "username": "xxxx",
		 "credential": "yyyy",
	   }
	 ]
	}
	```

	为此，需要在后台开发`TURN 配置`页面，该页面首期先支持填写cloudflare TURN，以后再支持别的渠道的TURN接入。
	`TURN配置`页面中，划定一个表单区域名为`Cloudflare TURN`，表单如下

	```
	   Turn名称：        ____________（这个只是备注，不参与API调用）
	   Turn令牌ID：      ____________
	   API令牌：         ____________
	   下发配置缓存时间： ____________（API请求后的返回信息默认缓存1天）

						 [保 存]
	```
	另外，看到目前服务端代码最终会从tunnel.config.json文件获取获取TURN配置，但我禁止程序去改动这个文件，我也不想在这个文件配置动态可变的TURN配置。因此就不要改动PROJECT_CONFIG_PATH的原有获取逻辑。
	为了能向浏览器下发动态的TURN配置信息，可以考虑在请求服务端`/runtime-config.js`时，调用cloudflare TURN API获取TURN配置信息，并包装到下发对象`window.TUNNEL_CONFIG.RTC`。
	TURN配置信息要緩存，过期后应重新请求API。














【新】
**6、为隧道 WebRTC 文件传输增加 Cloudflare TURN 支持，并提供后台配置页面**

为隧道文件传输的 WebRTC 连接增加 Cloudflare TURN 支持。TURN 提供 WebRTC 中继能力，与系统现有的 Socket.IO Relay 属于不同的传输路径。

首期接入 Cloudflare TURN，其它 TURN 服务提供方留待后续支持。

**6.1、由后端生成短期凭据**

后台保存以下 Cloudflare TURN 配置信息：

- TURN 名称。
- TURN 令牌 ID。
- API 令牌。
- 下发配置缓存时间。

TURN 名称仅作为备注，不参与 API 调用。

后端使用 TURN 令牌 ID 和 API 令牌调用 Cloudflare API，生成客户端可使用的短期凭据。长期 API 令牌保留在服务端，浏览器取得的是生成后的 ICE 配置及短期凭据。[Cloudflare 官方凭据说明](https://developers.cloudflare.com/realtime/turn/generate-credentials/)

请求示例：

```bash
curl --request POST \
  "https://rtc.live.cloudflare.com/v1/turn/keys/<TURN_KEY_ID>/credentials/generate-ice-servers" \
  --header "Authorization: Bearer <TURN_KEY_API_TOKEN>" \
  --header "Content-Type: application/json" \
  --data '{"ttl": 86400}'
```

其中，`ttl: 86400` 表示生成的短期凭据有效期为 86400 秒，即一天。

返回结构示例如下，实际地址和凭据以 API 响应为准：

```json
{
  "iceServers": [
    {
      "urls": [
        "stun:stun.cloudflare.com:3478"
      ]
    },
    {
      "urls": [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:3478?transport=tcp",
        "turns:turn.cloudflare.com:5349?transport=tcp"
      ],
      "username": "<短期用户名>",
      "credential": "<短期凭据>"
    }
  ]
}
```

**6.2、新增后台“TURN 配置”页面**

后台新增“TURN 配置”页面，首期设置一个名为“Cloudflare TURN”的表单区域，包含以下字段：

| 字段 | 说明 |
|---|---|
| TURN 名称 | 仅作备注，不参与 API 调用。 |
| TURN 令牌 ID | 用于构造生成短期凭据的 API 请求地址。 |
| API 令牌 | 用于服务端请求认证。 |
| 下发配置缓存时间 | 单位为秒，默认 `86400`，即一天。 |

表单提供“保存”按钮，保存该组配置。

**6.3、保留项目配置文件的原有读取逻辑**

当前服务端通过 `PROJECT_CONFIG_PATH` 读取 `tunnel.config.json`，并在 `/runtime-config.js` 中将 `projectConfig.rtc` 下发到：

```javascript
window.TUNNEL_CONFIG.RTC
```

本项要求：

- 不修改 `PROJECT_CONFIG_PATH` 的既有定义和读取逻辑。
- 禁止程序为保存动态 TURN 设置而改写 `tunnel.config.json`。
- 不要求用户在该文件中维护动态可变的 Cloudflare TURN 配置。
- 动态 TURN 配置由新增的后台页面单独保存和管理。

**6.4、通过运行时配置下发，并接入隧道文件连接**

可以沿用原文提出的方式，在浏览器请求 `/runtime-config.js` 时，由服务端取得有效的 Cloudflare ICE 配置，包装到：

```javascript
window.TUNNEL_CONFIG.RTC
```

当前隧道文件传输的 `createPeerConnection()` 仍使用写死的 STUN 列表，没有读取这里的运行时 RTC 配置。因此，本项还需要让隧道文件连接在创建 `RTCPeerConnection` 时，实际使用本次下发的 `iceServers`，不能仅完成服务端下发。

**6.5、缓存 API 返回的配置，过期后重新获取**

Cloudflare API 返回的 ICE 配置和短期凭据应在服务端缓存，默认缓存一天。

- 缓存有效时，重复请求 `/runtime-config.js` 使用有效缓存。
- 缓存过期后，重新调用 Cloudflare API 获取配置。
- 浏览器仅接收使用 TURN 所需的 ICE 地址和短期凭据。

“下发配置缓存时间”与 API 请求中的 `ttl` 是两个概念：前者决定服务端何时重新获取配置，后者决定凭据自签发起何时失效。重复下发缓存不会重新计算凭据有效期，不能将已经失效的凭据继续作为有效配置下发。[Cloudflare 凭据有效期说明](https://developers.cloudflare.com/realtime/turn/generate-credentials/)


**6.6、Cloudflare TURN 的启用边界、传输策略及后台说明**

**6.6.1、局域网本地测试环境禁止使用 Cloudflare TURN**

设备处于同一局域网，并通过局域网 IP 访问本地测试服务时，文件传输按以下顺序执行：

```text
设备间局域网直连
        ↓ 直连不可用
局域网 Node.js 服务器的 Socket.IO Relay
        ↓ 仍不可用
明确报告失败
```

本环境下，收发双方均不得使用 Cloudflare TURN。不能因为后台已经保存 TURN 配置就自动启用，也不能在本地 Socket.IO Relay 失败后改走 Cloudflare TURN。

“优先局域网直连”不代表能够保证所有设备都成功建立直连；直连受到限制时，使用局域网服务器中继兜底，传输路径仍应保留在局域网内。

**6.6.2、公网域名正式环境优先直连，TURN 和 Socket.IO Relay 作为兜底**

对于通过公网域名访问的正式环境，同局域网设备仍应优先使用局域网直连。访问网站使用公网域名，不代表文件必须经过公网中继。

Cloudflare TURN 已正确配置且凭据有效时，按以下策略使用：

```text
设备间直连，同局域网时优先局域网直连
        ↓ 直连不可用
Cloudflare TURN
        ↓ 无法连通、发送端或接收端传输不畅，或实际速率特别低
Socket.IO Relay
```

具体要求：

- 正常工作的局域网直连不应被主动替换为 Cloudflare TURN 或 Socket.IO Relay。
- 需要中继时，优先尝试 Cloudflare TURN；出现上述问题后，切换到 Socket.IO Relay。
- Cloudflare TURN 未配置、凭据不可用或服务不可用时，保留 Socket.IO Relay 兜底能力。
- Cloudflare TURN 用于补充连通能力，不能承诺提高已经正常工作的局域网直连速度。

本次问答尚未确定“传输不畅”“速率特别低”的具体判定时限和阈值，不能将其擅自写成已经确认的数值。

**6.6.3、根据实际连接和传输情况判断路径**

路径判断和切换应依据实际连接及传输情况，不能仅凭界面上的“P2P”标签认定链路正常或已经实现局域网直连。

需要区分以下路径：

- 设备间局域网直连。
- 经过 Cloudflare TURN 的 WebRTC 中继。
- 经过 Node.js 服务器的 Socket.IO Relay。

Cloudflare TURN 虽然承载 WebRTC 连接，但文件经过公网中继，不能将其等同于局域网直连。本地测试环境也不能仅通过“不配置 TURN”就认定文件没有绕公网，仍需核对实际连接路径。

**6.6.4、后台通过 `i` 按钮查看使用说明**

在后台“TURN 配置”页面的“Cloudflare TURN”表单区域增加 `i` 说明按钮。

说明默认不展开、不直接占用表单正文区域；用户点击 `i` 按钮后，以浮层小看板显示。

说明内容应清楚覆盖：

- **用途**：Cloudflare TURN 提供公网 WebRTC 中继，补充直连不可用时的连通能力，不保证局域网提速。
- **禁止使用的环境**：同局域网、通过局域网 IP 访问的本地测试环境不使用 Cloudflare TURN，仅允许局域网直连及本地服务器 Socket.IO Relay。
- **正式环境策略**：优先直连；直连不可用时先尝试 Cloudflare TURN，发送端或接收端传输不畅、速率特别低时改用 Socket.IO Relay。
- **保留正常路径**：填写并保存 TURN 配置，不意味着所有传输都经过 TURN，也不应主动替换正常工作的局域网直连。






