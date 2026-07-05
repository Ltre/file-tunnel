问：
    有个需求，草稿如下（可能存在语义问题），你重新审视这条需求：
    5、发现发送文件要绑定文件句柄时会有系统权限请求，要求用户允许对具体的文件读写操作，感觉这种机制很容易让传输记录里的文件丢失文件系统句柄，如果某个带句柄的文件记录没有及时将二进制数据同步到别的设备，就发生了文件句柄失效情况，那就会导致这个文件永久无法恢复缓存副本。所以要在给传输记录的文件绑定文件句柄前，执行以下工作流：       
        5.1、先复制一个文件二进制数据副本到浏览器缓存里备用（此时这个缓存副本在隧道里属于游离态的）
        5.2、检查同隧道有没有其它设备在线，如果有，且要等其它设备完全接收了该文件的二进制数据后才删除这个缓存副本，如果没有，那就要保留这个缓存副本，暂时先挂在这个文件ID身上（注意跟其它无句柄绑定的文件的区别，要特殊对待） 
        5.3、如果在其他设备完全拉到该文件的缓存副本之前，就发生了句柄失效（文件移动、改名、删除、浏览器授权解除等等）的情况，就要第一时间让这个文件和缓存副本绑定
        
        
        
答：


    我看懂了，而且这个需求是合理的。你真正担心的是：

    ```text id="i8nczh"
    绑定文件句柄的文件，如果没有先形成至少一个可靠二进制副本，那么这个文件记录其实是“脆弱的”。
    一旦本机原文件被移动、改名、删除，或浏览器权限失效，这条传输记录就只剩元数据，无法再恢复缓存。
    ```

    当前代码确实有这个风险。普通缓存路径会把 `data` 写进 `files` store；但绑定外部文件句柄路径会写 `externalFileHandle`，没有同步写入 `data`。也就是说它更像“引用本机原文件”，不是“浏览器已有完整缓存”。

    ## 我建议把你的需求重新定义成一句话

    不是“绑定句柄前复制一份游离缓存”这么简单，而是：

    ```text id="wc18cq"
    任何外部文件句柄型文件，在确认至少一个可靠二进制副本存在前，不能进入 handle-only 状态。
    ```

    这里的“可靠二进制副本”可以是：

    ```text id="lkf3l2"
    1. 本机浏览器 IndexedDB 内的安全副本
    2. 同隧道其它设备已经完整接收并缓存
    ```

    只要两个都没有，就不能让文件只依赖 `externalFileHandle`。

    ## 你说的 5.1～5.3，我理解成这个状态机

    ### 初始发送

    用户选择文件，并且浏览器给了文件句柄：

    ```text id="htrmbs"
    externalFileHandle = true
    data = null
    ```

    这是危险状态，不应该直接落库为最终状态。

    ### 正确流程

    应该先变成：

    ```text id="qh58so"
    externalFileHandle = true
    data = ArrayBuffer
    safetyCopy = true
    safetyCopyState = 'pending-replica'
    ```

    意思是：

    ```text id="6i4yqk"
    这个文件绑定了本机原文件句柄；
    但在其它设备接收完成前，本机浏览器仍保留一份安全缓存副本。
    ```

    ### 如果同隧道没有其它设备在线

    那就继续保留：

    ```text id="k5c68d"
    safetyCopyState = 'waiting-online-peer'
    ```

    不能删这个安全副本。

    ### 如果有其它设备在线

    开始传输，但不能一发起就删。必须等到其它设备明确完成接收：

    ```text id="k9utxs"
    peerReplicaState = 'completed'
    ```

    才可以考虑释放本机安全副本。

    ### 如果句柄失效

    比如原文件移动、改名、删除、权限被撤销：

    ```text id="8x9vus"
    externalFileAvailable = false
    externalFileMissing = true
    ```

    这时如果 `data` 还在，就立刻把安全副本提升为正式缓存：

    ```text id="dy26k6"
    externalFileHandle = null 或 externalFileAvailable = false
    data = 原 safety copy
    cacheCleared = false
    safetyCopy = false
    sourceMode = 'browser-cache'
    ```

    也就是你说的：

    > 第一时间让这个文件和缓存副本绑定。

    我理解就是：**文件记录从“句柄来源”切换为“浏览器缓存来源”。**

    ## 我建议不要真的做“游离态副本”

    你提到“这个缓存副本在隧道里属于游离态”，这个表达容易让 Codex 做错，可能会额外创建一条没有消息引用的 file record。

    更稳的实现是：

    ```text id="hm0bwl"
    仍然挂在同一个 fileId 的 files 记录上。
    ```

    但通过字段区分：

    ```js id="li7i89"
    {
      id: fileId,
      sessionId,
      externalFileHandle,
      externalFileAvailable: true,
      data: ArrayBuffer,
      hasSafetyCopy: true,
      safetyCopyState: 'pending-replica',
      cacheCleared: false
    }
    ```

    这样所有预览、下载、还原、传输逻辑仍然按同一个 `fileId` 找，不会多出一个“影子文件”导致资源管理器混乱。

    所谓“游离态”可以只是业务状态，而不是另建资源。

    ## 重点区分三种文件

    你这个需求最关键的是别把三类文件混在一起：

    ```text id="8p3r1u"
    普通缓存文件：
    只有 data，没有 externalFileHandle。

    句柄文件，已有安全副本：
    有 externalFileHandle，也有 data。句柄优先，data 兜底。

    句柄文件，无安全副本：
    只有 externalFileHandle，没有 data。这个状态必须标红/警告，不能当成可靠缓存。
    ```

    第三种就是你现在担心的危险状态。

    ## 给 Codex 的需求稿

    修复外部文件句柄型文件可能永久丢失缓存来源的问题。

    背景：

    当前发送文件时，如果使用 File System Access API 绑定了外部文件句柄，代码会把 externalFileHandle 保存到 IndexedDB 的 files 记录中，但通常不会同时保存文件二进制 data。这种设计可以节省浏览器缓存空间，但存在严重风险：

    如果这个文件还没有被同隧道其它设备完整接收并缓存，而本机原文件发生移动、改名、删除，或浏览器文件权限被撤销，那么 externalFileHandle 会失效。此时传输记录里只剩文件元数据，无法再恢复文件缓存副本。

    目标：

    外部文件句柄不能成为某个文件记录的唯一可靠文件来源。任何绑定 externalFileHandle 的文件，在确认至少一个可靠二进制副本存在前，必须保留本机浏览器内的安全缓存副本。

    可靠二进制副本定义：

    1. 本机 IndexedDB files 记录里有完整 data。
    2. 或者同隧道其它设备已经明确完整接收并缓存该文件。

    修复要求：

    一、绑定 externalFileHandle 前，先创建本机安全副本。

    当用户选择文件并准备保存 externalFileHandle 时，不要直接只保存句柄。应先读取文件二进制内容，并写入当前 fileId 对应的 files 记录：

    {
    id: fileId,
    sessionId,
    externalFileHandle,
    externalFileAvailable: true,
    externalFilePermissionRequired: false,
    externalFileMissing: false,
    data: ArrayBuffer,
    hasSafetyCopy: true,
    safetyCopyState: 'pending-replica',
    cacheCleared: false,
    isFileAsset: true
    }

    注意：

    1. 不要另建一个游离 fileId。
    2. 安全副本应该挂在当前文件记录自己的 fileId 上。
    3. “游离态”只作为业务状态理解，不要创建额外无消息引用的文件记录，避免资源管理器和清理逻辑混乱。
    4. 如果因为浏览器配额不足或读取失败导致安全副本创建失败，不能静默保存为 handle-only 状态。必须在 UI 上提示用户：该文件当前只绑定本机原文件，原文件移动或权限失效后可能无法恢复。

    二、同隧道其它设备未完整接收前，不能删除安全副本。

    如果同隧道没有其它在线设备：

    * 保留 data。
    * 标记 safetyCopyState = 'waiting-online-peer'。
    * UI 可显示“本机原文件 + 安全副本，等待其它设备同步”。

    如果同隧道有其它设备在线：

    * 可以发起传输。
    * 但必须等至少一个其它设备明确完整接收并缓存该文件后，才允许删除本机安全副本。
    * 不要在传输开始、发送 offer、开始 P2P、开始 relay、或进度未到 100% 时删除安全副本。

    需要新增或复用确认机制：

    * 当其它设备完整接收并保存文件后，向发送端返回 asset-cache-confirmed / file-replica-confirmed 之类的确认事件。
    * 发送端收到确认后，可以将 safetyCopyState 更新为 'replicated'。
    * 只有 safetyCopyState === 'replicated' 时，用户点击释放空间或系统自动清理时，才允许删除这个安全副本。

    三、句柄失效时，自动提升安全副本为正式缓存。

    任何读取 externalFileHandle 失败的地方，都应进入统一处理函数，例如 handleExternalFileUnavailable(fileId, reason)。

    当检测到以下情况：

    * 原文件被移动
    * 原文件被删除
    * 原文件改名导致 handle 不可读
    * 浏览器权限被撤销
    * handle.getFile() 抛错
    * queryPermission 不再是 granted

    应执行：

    1. 读取当前 files 记录。
    2. 标记 externalFileAvailable = false。
    3. 标记 externalFileMissing = true 或 externalFilePermissionRequired = true。
    4. 如果当前 files.data 仍然存在且完整：

       * 将该 data 提升为正式浏览器缓存。
       * cacheCleared = false。
       * hasSafetyCopy = false。
       * safetyCopyState = 'promoted-after-handle-loss'。
       * sourceMode = 'browser-cache' 或类似字段。
       * UI 上显示“原文件句柄已失效，已改用浏览器缓存副本”。
    5. 如果 files.data 不存在：

       * 才显示“原文件不可用，且本机没有安全副本，需要等待其它设备在线还原”。

    四、释放空间/清理缓存逻辑要区分普通缓存和句柄安全副本。

    对于普通文件：

    * 用户点击释放空间，可以按现有逻辑清理本机 data。

    对于 externalFileHandle 文件：

    1. 如果 hasSafetyCopy = true 且 safetyCopyState 不是 'replicated'：

       * 不允许直接删除 data。
       * 或至少要强提醒：其它设备尚未完整缓存，删除后如果原文件句柄失效将无法恢复。
    2. 如果 safetyCopyState = 'replicated'：

       * 可以删除 data，只保留 externalFileHandle。
       * 记录仍应知道它曾经有安全副本，现在已因远端副本确认而释放。
    3. 如果 externalFileHandle 已失效，而 data 是唯一可用副本：

       * 不能把它当作普通可随便释放的缓存。
       * 除非用户明确确认“删除后无法从本机恢复”。

    五、UI 状态建议。

    文件详情或预览中，对 externalFileHandle 文件显示不同状态：

    1. “本机原文件可用”
    2. “本机原文件可用，安全副本待同步”
    3. “本机原文件可用，已被其它设备缓存，可释放本机安全副本”
    4. “原文件句柄已失效，已改用浏览器缓存副本”
    5. “原文件句柄已失效，且没有本机缓存，需等待其它设备还原”

    六、回归测试。

    请测试：

    1. 发送一个通过文件句柄绑定的大文件。
    2. 发送后不要让其它设备接收完成。
    3. 移动或删除原文件，或撤销浏览器文件权限。
    4. 回到传输记录，确认该文件不会永久丢失，应自动使用本机安全副本。
    5. 其它设备完整接收前，点击释放空间，不应直接删除安全副本。
    6. 其它设备完整接收并确认后，释放空间才可以删除本机安全副本。
    7. 同隧道没有其它设备在线时，绑定句柄文件必须保留安全副本。
    8. 如果浏览器配额不足，无法创建安全副本，必须提示用户风险，不能静默进入 handle-only 状态。
    9. 普通无句柄文件的缓存逻辑不能被破坏。
    10. 预览、下载、还原、生成磁链、资源管理器状态都要正确识别 externalFileHandle + safetyCopy 的组合状态。

    请不要简单取消 externalFileHandle 功能。目标不是禁止绑定文件句柄，而是避免 handle-only 文件在没有其它可靠副本时成为不可恢复记录。

    ## 我建议的 git log title

    ```text id="ofg8dm"
    protect handle-backed files with safety cache
    ```

    或者更直接：

    ```text id="qz6gb4"
    fix(files): prevent handle-only assets from becoming unrecoverable
    ```

    这个需求可以和前面“导入导出误删缓存”分开处理。它们同属缓存安全问题，但根因不同：前者是跨隧道 fileId 污染，后者是外部文件句柄失效导致来源丢失。
