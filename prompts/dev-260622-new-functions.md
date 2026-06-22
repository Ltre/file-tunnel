以下提几个需求（三/四/五/六），导致代码量会越来越大，应该先以目录拆分功能模块了（切忌算坏已经开发好的功能和已经多次调试解决的难题！）。 

三、
传输大文件时，在别的设备弹出是否接收，点击接收，发送端和接收端没有看到传输进度，可能代码里有些BUG（可以考虑复用协同编辑框开发时用的传输链路策略）。
请切换到新分支"dev-260623-new-functions"进行此需求的代码改动，但不要暂存，也不要提交。


四、
在"聊天记录"区域的下方点击或拖拽文件后，看到图片用的是data:image形式，吸取在协同编辑框踩坑的教训，也采用blob形式来传输文件，传输链路策略也仿照协同编辑框的来开发（或者复用代码，你看看好不好改了，如果不好改就弄另一套代码减少耦合度）。
新设备加入到会话中时，自动同步本会话中的历史传输记录，保持所有设备的历史传输记录一致。
在传输历史记录区域，也是存在多设备多媒体文件同步不齐的问题，估计也跟在解决协同编辑框遇到的传输链路问题差不多（我没看代码，自己猜的，你要有自己的判断）
请切换到新分支"dev-260623-new-functions"进行此需求的代码改动，但不要暂存，也不要提交。


五、
支持实时摄像头广播到同会话的其它设备：
指定一台作为广播发起端，则其它的自动变成广播接收端。
如果第二台设备想作为广播发起端，则会在第二台设备弹出提示“发起新的摄像头广播会中止其它正在进行的广播”
请切换到新分支"dev-260623-new-functions"进行此需求的代码改动，但不要暂存，也不要提交。

六、
在同一会话中的某个设备，可以发起语音聊天，支持三人及以上即时语音。
请切换到新分支"dev-260623-new-functions"进行此需求的代码改动，但不要暂存，也不要提交。

七、
对讲机功能（非即时语音聊天）：
点击设备列表某个非本机设备旁边的"对讲机"按钮，进入对讲机状态，本机将和对方建立临时的对讲机连接，本机说话时，会在对方的设备立即播放。
点击"关闭对讲机"按钮，即关闭临时的对讲机连接。
也有一个全局对讲机按钮，点击后本机和所有人建立临时的对讲机连接，本机说话时，会在所有其它设备立即播放。
请切换到新分支"dev-260623-new-functions"进行此需求的代码改动，但不要暂存，也不要提交。







---------------------------------------------------------------------







这是一组会跨越传输协议、历史一致性、媒体会话和设备控制的大改动。我会先把已有功能梳理成边界清楚的模块，再在新分支上逐项落地；现有协同编辑的资源 ID、Blob 缓存和 P2P/Socket.IO 降级链路会被保留并抽取复用，不会推倒重来。
先切换到你指定的新分支，并盘点当前代码与未提交修改，避免碰坏已经稳定的部分。




已运行 6 条命令已运行 git status --short --branch; git branch --show-current; git switch -c dev-260623-new-functions; git status --short --branch; rg --files







已运行 (Get-Item app.js).Length; (Get-Item server.js).Length; rg -n "^(function|async function|const .* = \(|class )" app.js







已运行 rg -n "^(function|const .* = \(|class |io\.on|app\.)" server.js







已运行 Get-Content app.js | Select-Object -Skip 1390 -First 440







已运行 Get-Content server.js | Select-Object -First 180; Get-Content server.js | Select-Object -Skip 780 -First 340







已运行 Get-Content app.js | Select-Object -Skip 1800 -First 280; Get-Content index.html | Select-Object -Skip 600 -First 130












传输历史这一块我不会再在聊天消息里塞 Base64。新的路径会让聊天记录只保存文件元数据，文件内容作为独立 Blob 资源通过 P2P 优先、Socket.IO 中继降级获取；新设备拿到历史元数据后自动拉取资源。
我先把这套通用文件资源传输放进独立模块，随后把旧的聊天文件入口切过去。




已创建 2 个文件编辑了 2 个文件执行了 4 条命令已创建file-assets.js+266-0









已编辑index.html+1-0









已运行 Get-Content app.js | Select-Object -Skip 410 -First 410







已编辑app.js+33-21









已编辑app.js+31-4









已编辑app.js+42-59









已运行 Get-Content app.js | Select-Object -Skip 2010 -First 190







已编辑app.js+8-2









已编辑app.js+14-15









已运行 rg -n -C 4 "unavailableLabel|fileData|isStoredFile|fileUrl" app.js







已编辑app.js+5-3









已编辑app.js+48-5









已编辑app.js+25-9









已运行 Get-Content server.js | Select-Object -Skip 230 -First 160; Get-Content server.js | Select-Object -Skip 1120 -First 70







已创建file-assets.js+183-0














文件资源模块已建立：客户端和服务端各自独立于协同编辑的资源协议。它与协同编辑共用“专用 P2P 数据通道优先、Socket.IO 64KB 分块中继兜底”的策略，但不会混用图片编辑器的状态、DOM 或大小约束。现在把服务端注册、会话资源目录和聊天元数据接上。




编辑了 3 个文件已编辑server.js+32-11









已编辑app.js+18-3









已编辑file-assets.js+7-0









已编辑app.js+1-0









已编辑app.js+9-3














聊天文件已改为“元数据先入历史、内容按需独立拉取”：小文件自动拉取，大文件保留接收确认；两端都会显示进度，且不再把任何图片转成 data:image。我现在做一次代码层的完整语法检查，随后再接入媒体会话功能。




编辑了 1 个文件执行了 1 条命令已运行 $paths = @('app.js','server.js','index.html','client\file-assets.js','server\file-assets.js'); foreach ($relativePath in $paths) { $path = Join-Path (Get-Location) $relativePath; $content = [System.IO.File]::ReadAllText($path); $content = $content.Replace("`r`n", "`n"); [System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false)) }; $node = 'C:\Users\Dell\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'; & $node --check app.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; & $node --check server.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; & $node --check client\file-assets.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; & $node --check server\file-assets.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; git diff --check; git diff --stat; git status --short --branch，已持续 1s







已编辑app.js+1-1














文件模块的语法已经通过；接下来进入媒体部分。这里会使用独立的 WebRTC 媒体连接，不触碰现有文件/编辑器的数据通道，避免它们的协商互相干扰：摄像头是单发多收，语音是会话内 mesh，对讲机是临时单向音频连接。




已创建 2 个文件编辑了 4 个文件执行了 2 条命令已创建media.js+227-0









已创建media-session.js+108-0









已编辑server.js+13-0









已编辑server.js+6-0









已运行 Get-Content index.html | Select-Object -Skip 600 -First 145; Get-Content app.js | Select-Object -Skip 2550 -First 105







已运行 Get-Content app.js | Select-Object -Skip 2580 -First 130







已编辑index.html+10-0









已编辑app.js+11-0









已编辑app.js+50-0









已编辑app.js+37-0









已编辑app.js+15-0









已编辑media.js+6-0









已编辑media.js+1-0














模块边界现在已经落到目录中：client/file-assets.js 管独立文件 Blob 传输，server/file-assets.js 管资源目录和中继，client/media.js 与 server/media-session.js 管媒体会话。已有编辑器资源链路保持原样。
接下来我会做整套语法检查，并检查浏览器静态入口确实加载新模块；之后整理当前已完成的行为与仍需真实设备验证的 WebRTC 部分。




已运行 2 条命令已运行 $paths = @('app.js','server.js','index.html','client\file-assets.js','client\media.js','server\file-assets.js','server\media-session.js'); foreach ($relativePath in $paths) { $path = Join-Path (Get-Location) $relativePath; $content = [System.IO.File]::ReadAllText($path); $content = $content.Replace("`r`n", "`n"); [System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false)) }; $node = 'C:\Users\Dell\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'; & $node --check app.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; & $node --check server.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; & $node --check client\file-assets.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; & $node --check client\media.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; & $node --check server\file-assets.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; & $node --check server\media-session.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; git diff --check; git diff --stat; git status --short --branch，已持续 1s







已运行 git diff -- server.js app.js index.html; git diff --no-index -- /dev/null client\file-assets.js; git diff --no-index -- /dev/null client\media.js; git diff --no-index -- /dev/null server\file-assets.js; git diff --no-index -- /dev/null server\media-session.js













上下文已自动压缩



我已经把大文件传输和媒体能力先从主文件拆到独立模块里，保留了原有协同编辑资源链路，避免把之前反复调通的逻辑揉坏。现在我在做一轮针对性收口：媒体状态、摄像头音频，以及文件同步的真实入口路径。




已运行 12 条命令已运行 git status --short --branch







已运行 rg -n -C 3 "registerFileAssetHandlers|registerMediaHandlers|cleanupFileAssetRelays|cleanupMediaDevice|fileAssets|session\.media" server.js







已运行 rg -n -C 3 "function updateMediaButtons|function showCameraStream|initMediaController|initFileAssetTransfer|async function sendFile|function handleSessionHistory|function handleMessage" app.js







已运行 Get-ChildItem -Recurse client,server | Select-Object FullName,Length







已运行 git status --short --branch







已运行 rg -n -C 3 "function updateMediaButtons|function showCameraStream|initMediaController|initFileAssetTransfer|async function sendFile|function handleSessionHistory|function handleMessage" app.js







已运行 Get-ChildItem -Recurse client,server | Select-Object FullName,Length | Format-Table -AutoSize







已运行 rg -n -C 3 "registerFileAssetHandlers|registerMediaHandlers|cleanupFileAssetRelays|cleanupMediaDevice|fileAssets|session\.media" server.js







已运行 $lines = Get-Content app.js; $lines[1445..1530]







已运行 $lines = Get-Content client\media.js; $lines[1..260]







已运行 $lines = Get-Content client\file-assets.js; $lines[1..330]







已运行 $lines = Get-Content server\media-session.js; $lines[1..260]












上传文件现在不再把内容塞进聊天消息或 HTML 的 data: URL；消息只保存元数据，字节数据单独以 Blob/ArrayBuffer 进入 IndexedDB，并按“P2P 优先、Socket.IO 中继兜底”传输。这也让新设备可以先同步历史条目，再按需拉取文件本体。




已运行 15 条命令已运行 rg -n -C 3 "cameraBroadcastBtn|voiceChatBtn|globalIntercomBtn|cameraStage|deviceList" index.html







已运行 rg -n -C 3 "file-asset|file-offer|message'|session-history" server.js







已运行 rg -n -C 3 "sendFile\(|drag|drop|fileInput|fileList" app.js index.html







已运行 rg -n -C 3 "onProgress|onReceived|onUnavailable|file-asset" app.js







已运行 rg -n -C 10 "function updateDeviceList|对讲机|startIntercom|cameraBroadcastBtn" app.js







已运行 $lines = Get-Content app.js; $lines[1925..2110]







已运行 $lines = Get-Content app.js; $lines[2780..2885]







已运行 $lines = Get-Content server.js; $lines[450..610]; $lines[1100..1185]







已运行 $lines = Get-Content app.js; $lines[2110..2260]







已运行 $lines = Get-Content app.js; $lines[300..570]







已运行 $lines = Get-Content app.js; $lines[160..280]







已运行 $lines = Get-Content server\file-assets.js; $lines[1..320]







已运行 $lines = Get-Content index.html; $lines[650..710]







已运行 rg -n -C 4 "function showConfirmModal|confirmFileBtn|acceptFile|fileTransfers" app.js







已运行 $lines = Get-Content app.js; $lines[1420..1478]












我确认了一个会造成“历史条目有了、文件本体仍然缺失”的竞态：新设备先请求、旧设备稍后才把本机缓存的文件登记为可提供时，原逻辑会放弃重试。我会把“需要该文件”的意图保留到真正收到文件为止，并让历史同步在本地只有消息而缺少文件时自动补拉。与此同时修正摄像头的本地静音/远端播放状态。




编辑了 2 个文件执行了 5 条命令已编辑app.js+12-0






已编辑file-assets.js+5-1









已运行 $paths = @('app.js','server.js','index.html','client\file-assets.js','client\media.js','server\file-assets.js','server\media-session.js'); foreach ($relativePath in $paths) { $path = Join-Path (Get-Location) $relativePath; $content = [System.IO.File]::ReadAllText($path); $content = $content.Replace("`r`n", "`n"); [System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false)) }







已运行 $lines = Get-Content app.js; $lines[260..470]







已运行 $lines = Get-Content app.js; $lines[1530..1615]







已运行 $lines = Get-Content app.js; $lines[2960..3010]







已运行 $lines = Get-Content server.js; $lines[610..685]












媒体链路是独立 WebRTC 连接，不会挤占原来的聊天/P2P 数据通道；语音采用房间内 mesh，摄像头是“单主播对所有观看者”扇出，对讲机则是按目标建立的单向临时音频流。现在再把服务端的媒体信令限制在同一会话内，避免任何跨会话的错误路由。




编辑了 2 个文件执行了 7 条命令已编辑media.js+1-0






已编辑media-session.js+5-1









已运行 Get-Content package.json







已运行 rg -n "function waitForDataChannel|ondatachannel|setupDataChannel" app.js







已运行 rg -n "MAX_FILE_ASSET_SIZE|MAX_MESSAGE_SIZE|const PORT|listen\(" server.js server\file-assets.js







已运行 git diff --stat; git diff -- app.js index.html server.js | Select-Object -First 260







已运行 Get-Content package.json







已运行 rg -n -C 4 "function waitForDataChannel|ondatachannel|setupDataChannel" app.js







已运行 rg -n "MAX_FILE_ASSET_SIZE|MAX_MESSAGE_SIZE|const PORT|listen\(" server.js server\file-assets.js












文件上传入口（点击选择与拖放）已经都走同一个 sendFile 路径；小文件不会再作为 Base64 附在消息里，大文件也不再走旧的“offer 后无进度”分支。接收端确认后才请求本体，双方都会进入同一个进度条机制；P2P 建不起来会切到每块 64KB 的 Socket.IO 中继。




已运行 14 条命令已运行 Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess，已持续 1s







已运行 git status --short --branch







已运行 & 'C:\Users\Dell\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check app.js; & 'C:\Users\Dell\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check server.js; & 'C:\Users\Dell\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check client\file-assets.js; & 'C:\Users\Dell\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check client\media.js; & 'C:\Users\Dell\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check server\file-assets.js; & 'C:\Users\Dell\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check server\media-session.js; git diff --check，已持续 1s







已运行 & 'C:\Users\Dell\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check app.js







已运行 git status --short --branch







已运行 & 'C:\Users\Dell\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check server.js; & 'C:\Users\Dell\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check client\file-assets.js; & 'C:\Users\Dell\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check client\media.js; & 'C:\Users\Dell\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check server\file-assets.js; & 'C:\Users\Dell\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check server\media-session.js







已运行 Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess，已持续 1s







已运行 git diff --check







已运行 git diff --check







已运行 & 'C:\Users\Dell\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check server.js; & 'C:\Users\Dell\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check client\file-assets.js; & 'C:\Users\Dell\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check client\media.js; & 'C:\Users\Dell\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check server\file-assets.js; & 'C:\Users\Dell\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check server\media-session.js







已运行 git status --short --branch







已运行 Test-Path node_modules; Get-ChildItem node_modules -ErrorAction SilentlyContinue | Select-Object -First 5 -ExpandProperty Name







已运行 Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess | Format-Table -HideTableHeaders







已运行 Test-Path node_modules; Get-ChildItem node_modules -ErrorAction SilentlyContinue | Select-Object -First 5 -ExpandProperty Name












实现层面已经完成了一轮静态检查。接下来我会启动这份工作区的 3000 服务并做一次页面级冒烟检查，确认新增脚本能被加载、Socket.IO 和基础页面没有因为模块拆分失效。




已运行 3 条命令已运行 3 条命令used 浏览器已运行 Get-Content 'C:\Users\Dell\.codex\plugins\cache\openai-bundled\browser\26.616.51431\skills\control-in-app-browser\SKILL.md'







已运行 $node = 'C:\Users\Dell\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'; $process = Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory (Get-Location) -WindowStyle Hidden -PassThru; Start-Sleep -Milliseconds 800; "PID=$($process.Id)"; Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess | Format-Table -HideTableHeaders，已持续 1s







已运行 Get-Process -Id 5692 -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,StartTime | Format-Table -HideTableHeaders; try { $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/' -TimeoutSec 3; "STATUS=$($response.StatusCode)"; "HAS_FILE_ASSET=$($response.Content -match 'client/file-assets.js')"; "HAS_MEDIA=$($response.Content -match 'client/media.js')" } catch { "REQUEST_FAILED=$($_.Exception.Message)" }







Connect to local app





Verify local page





Inspect local page





Clean up browser check










页面文件已由实际启动的本地服务返回，新增的 client/file-assets.js 和 client/media.js 也确实出现在 HTML 中。浏览器自动化通道在这台环境里没有响应，我没有把它当作功能成功的依据；接下来以脚本语法、diff 完整性和本地 HTTP 冒烟结果作最终收口。




已运行 6 条命令已运行 $paths = @('app.js','server.js','index.html','client\file-assets.js','client\media.js','server\file-assets.js','server\media-session.js'); foreach ($relativePath in $paths) { $path = Join-Path (Get-Location) $relativePath; $content = [System.IO.File]::ReadAllText($path); $content = $content.Replace("`r`n", "`n"); [System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false)) }; & 'C:\Users\Dell\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check app.js; & 'C:\Users\Dell\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check server.js; & 'C:\Users\Dell\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check client\file-assets.js; & 'C:\Users\Dell\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check client\media.js; & 'C:\Users\Dell\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check server\file-assets.js; & 'C:\Users\Dell\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check server\media-session.js; git diff --check; $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/' -TimeoutSec 3; if ($response.StatusCode -ne 200 -or $response.Content -notmatch 'client/file-assets.js' -or $response.Content -notmatch 'client/media.js') { throw 'Local smoke check failed' }; Write-Output 'Static checks and local HTTP smoke check passed.'，已持续 1s







已启动后台终端以及 git status --short --branch







已运行 rg -n "[ \t]+$" client\file-assets.js client\media.js server\file-assets.js server\media-session.js







已运行 Test-Path node_modules\socket.io-client







已启动后台终端以及 git diff --numstat; git ls-files --others --exclude-standard







已运行 Test-Path node_modules\socket.io-client; git status --short --branch; git diff --numstat; git ls-files --others --exclude-standard















已在 dev-260623-new-functions 完成改动，未暂存、未提交。
聊天文件上传与拖放统一改为 Blob/ArrayBuffer 存储和传输，不再把新文件放进 data: URL；采用 P2P 优先、Socket.IO 分块中继兜底，并显示收发进度。[app.js](D:\\Workspace\\github\\Ltre\\file-tunnel\\app.js) [file-assets.js](D:\\Workspace\\github\\Ltre\\file-tunnel\\client\\file-assets.js)
新设备加入会话会同步历史记录并自动补拉缺失文件；断线重连时也会重新登记本机缓存，处理“先请求、后有来源上线”的竞态。
新增单主播摄像头广播、多人语音聊天、单设备与全局对讲机；媒体信令限制在同一会话内。[media.js](D:\\Workspace\\github\\Ltre\\file-tunnel\\client\\media.js) [media-session.js](D:\\Workspace\\github\\Ltre\\file-tunnel\\server\\media-session.js)
服务端新增文件资产登记、中继与断线清理。[server.js](D:\\Workspace\\github\\Ltre\\file-tunnel\\server.js) [file-assets.js](D:\\Workspace\\github\\Ltre\\file-tunnel\\server\\file-assets.js)
已通过所有新增/修改 JS 的语法检查、git diff --check，并确认本地服务 http://127.0.0.1:3000/ 返回 200 且加载新模块。服务目前已启动，可用 http://10.0.0.16:3000/ 做多设备实测。实际摄像头、语音与跨设备文件传输仍需用 Chrome/Firefox 与 Android 真机做联调验证。


--------------------------------------


1、大文件接收进度的百分比看起来没有变化（很大文件也没看到变化，最后却是收到文件了）
2、文件传输会导致浏览器存储占用变得很大，应该在每个传输历史的右边加个清除缓存按钮（某个传输历史项一旦被清除了缓存，就要标记一下，防止重新加载页面后从别的设备获取文件内容，除非主动加载这个文件的内容到缓存(在被清理缓存后提供”还原文件“按钮)）
3、可在传输历史的每条记录旁边提供删除按钮（要提醒删除操作会一起删除所有设备的同一条记录，且清理文件缓存）
4、在传输历史记录标注文件大小。
5、测试了对讲机，提示”无法启动对讲机: 当前浏览器不支持媒体采集“，在windows和android的chrome/firefox都这样提示。
6、测试了摄像头，提示”无法启动摄像头: 当前浏览器不支持媒体采集“，在windows和android的chrome/firefox都这样提示。
7、测试了语音聊天，提示”无法加入语音聊天: 当前浏览器不支持媒体采集“，在windows和android的chrome/firefox都这样提示。
