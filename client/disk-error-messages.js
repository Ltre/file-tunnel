(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.DiskErrorMessages=factory();})(typeof window==='object'?window:this,function(){
    'use strict';
    const reasons = {
        DESTINATION_INSIDE_SOURCE:'目标目录位于来源目录内部，不能将目录复制到自身或其子目录。请选择来源目录之外的位置。',
        SAME_COLLABORATION:'来源和目标是同一个协同项目。请使用项目内的复制/移动功能，或选择另一个项目。',
        NATIVE_PAIR:'来源和目标都是个人网盘。请使用普通复制/移动功能。',
        REQUEST_SCOPE_INVALID:'来源或目标信息不完整或类型不合法。请重新选择来源与目标。',
        COPY_IDENTITY_INVALID:'复制的目标写入信息不一致，系统已拦截操作。请刷新后重试，持续失败时提供请求编号。',
        NATIVE_OWNER_MISMATCH:'个人网盘来源或目标不属于当前账号。请使用本人分区或已获授权的协同项目。',
        OWN_PROJECT_USE_NATIVE:'此协同项目属于当前账号。请从自己的网盘目录使用复制/移动功能，不要按受邀项目操作。',
        MOUNT_IN_SOURCE:'来源目录包含协同挂载入口，不能随目录复制到其它项目。请选择原生文件/子目录，或先移除本地挂载入口；移除入口不会删除他人的协同内容。',
        SOURCE_OUTSIDE_GRANT:'所选来源目录不在当前协同授权范围内。请刷新并重新选择来源。',
        TARGET_OUTSIDE_GRANT:'目标目录不在目标协同授权范围内。请重新选择目标目录。',
        FILE_GRANT_TARGET:'单文件协同授权不能作为目录接收复制内容。请选择有编辑权限的目录项目。',
        ROOT_PROTECTED:'当前操作不允许修改或删除协同根目录本身。请在其内部操作，或联系所有者。',
        SOURCE_ROOT_INVALID:'不能将整个网盘根目录作为此次复制的来源。请选择具体目录。',
        FILE_OUTSIDE_GRANT:'文件不在当前协同授权范围内，或已不可访问。请刷新后重新选择。',
        UPLOAD_SOURCE_PATH:'协同上传不能指定服务器来源路径。请上传本地文件。',
        UPLOAD_OUTSIDE_GRANT:'上传任务不属于当前协同项目，或已经结束。请检查任务来源并刷新。',
        ROUTE_OUTSIDE_GRANT:'此操作不在当前协同项目开放的功能范围内。',
        GRANT_CHANGED:'协同授权已撤销、成员权限或授权版本发生变化。请刷新项目，必要时联系所有者。',
        GRANT_VERSION_CHANGED:'协同授权已更新，当前操作使用的授权版本已过期。请刷新项目后重新执行。',
        GRANT_MEMBERSHIP_MISSING:'当前账号没有此项目的协同授权，或已退出/被移除。请联系所有者重新邀请。',
        PATH_OUTSIDE_GRANT:'所选路径不在当前协同项目授权范围内。请返回受邀目录内部操作。',
        FILE_GRANT_SOURCE:'当前只有单文件授权，不能把它作为目录复制。请选择获邀的文件。',
        STATIC_FILE_OPEN:'此文件单独或经父目录开放为静态资源。请先停止对应开放，再修改、删除或替换。',
        STATIC_DIRECTORY_OPEN:'此目录、其父目录或子项仍有静态资源开放设置。请先停止受影响的开放设置。',
        PATH_BLOCKED_BY_FILE:'目标目录路径被同名文件占用，无法建立目录。请处理冲突或选择其它位置。',
        TARGET_READ_ONLY:'目标协同项目只有查看权限，无法写入复制结果。请申请编辑权限或选择其它目标。',
        SOURCE_UNAVAILABLE:'来源文件、目录或其父目录已删除、屏蔽或不可访问。请刷新后重新选择。',
        CONTENT_REFERENCE_MISSING:'来源文件尚未建立可复用的内容引用，当前无法通过此方式复制。',
        SOURCE_REFERENCE_CHANGED:'来源文件的内容引用或所在位置已变化。请刷新来源后重新复制。',
        TARGET_UNAVAILABLE:'目标目录或其父目录不存在、已屏蔽或不可访问。请重新选择目标。',
        NAME_CONFLICT:'目标位置已有同名文件、目录、挂载项或正在上传的项目。请更改名称或选择其它位置。',
        NAME_PENDING_UPLOAD:'目标名称或目录路径正被上传任务占用。请等待上传结束，或选择其它名称与位置。',
        TRASH_PARENT_MISSING:'原所在目录已不存在，无法还原。请先重新创建原目录，再执行还原。',
        TRASH_PARENT_BLOCKED:'原父目录或祖先目录已被管理员屏蔽/删除，无法还原到该位置。请联系管理员恢复目录的可用状态。',
        TRASH_RESTORE_CONFLICT:'原位置存在同名项目或文件阻挡了目录路径。请处理冲突后再还原。'
    };
    const codes = {
        CONTENT_COPY_SCOPE_INVALID:'复制的来源与目标范围不符合当前操作要求。请重新选择。',
        COLLABORATION_OUT_OF_SCOPE:'操作超出当前协同授权范围。请在受邀项目内部操作。',
        COLLABORATION_NOT_FOUND:reasons.GRANT_CHANGED,
        COLLABORATION_READ_ONLY:reasons.TARGET_READ_ONLY,
        COLLABORATION_TARGET_NOT_FOUND:'协同来源文件或目录已不存在或不可访问。请联系所有者。',
        COLLABORATION_DISABLE_BEFORE_DELETE:'项目仍在协同编辑中。请先取消协同，再删除。',
        CONTENT_COPY_SOURCE_INVALID:reasons.SOURCE_UNAVAILABLE,
        CONTENT_COPY_TARGET_INVALID:reasons.TARGET_UNAVAILABLE,
        CONTENT_COPY_SOURCE_CHANGED:reasons.SOURCE_REFERENCE_CHANGED,
        CONTENT_COPY_MODE_INVALID:'跨协同授权范围只支持复制，不支持移动；来源内容会保留。',
        CONTENT_COPY_SELF_OWNED:'来源资源原本就属于当前账号，无需再次转存给自己。',
        CONTENT_COPY_TOO_LARGE:'复制包含超过 10000 个文件或目录。请分批选择。',
        DISK_NAME_CONFLICT:reasons.NAME_CONFLICT,
        DISK_NAME_INVALID:'名称或路径不合法。请去除系统保留字符、空路径段及相对路径。',
        DIRECTORY_NOT_FOUND:reasons.TARGET_UNAVAILABLE,
        FILE_NOT_FOUND:'文件不存在或已被删除。请刷新列表。',
        FILE_REMOVED_BY_REVIEW:'文件已由管理员删除，不能通过普通回收站还原。',
        DISK_SPACE_NOT_FOUND:'分区不存在、已删除或不属于当前账号。请刷新分区列表。',
        DISK_SPACE_INVALID:'分区名称不合法，请避免路径符号及系统保留字符。',
        DISK_SPACE_EXISTS:'当前账号已有同名分区。请更换名称。',
        STATIC_RESOURCE_ACTIVE:'项目或其子项正在开放静态资源。请先停止相关开放，再修改、删除或替换。',
        STATIC_OR_COLLABORATION_ACTIVE:'项目仍有静态开放或协同编辑设置。请先停止相关设置。',
        MOUNT_TRANSFER_UNSUPPORTED:'来源目录包含协同挂载项，当前不能随目录跨授权复制。请移除挂载或分别选择原生内容。',
        MOUNT_NAME_CONFLICT:reasons.NAME_CONFLICT,
        MOUNT_COLLABORATION_OVERLAP:'挂载位置与本人协同目录范围重叠。请选择其它原生目录。',
        MOUNT_ACCESS_REVOKED:'挂载对应的协同权限已失效。请联系所有者或移除本地挂载入口。',
        MOUNT_GRANT_NOT_AVAILABLE:'协同项目不可访问，或属于本人。请刷新并选择仍有权限的受邀项目。',
        CONTENT_NOT_AVAILABLE:'文件正文暂不可用，无法建立有效内容引用。请检查资源状态后重试。',
        CONTENT_LEASE_EXPIRED:'操作使用的内容读取/复制凭据已过期。请重新执行操作。',
        CONTENT_WRITE_CONFLICT:'内容引用在操作期间发生变化。请刷新后重新执行。',
        DISK_WRITE_CONFLICT:'网盘数据同时被其它操作修改，本次写入发生冲突。请刷新后重试。',
        ERR_SQLITE_ERROR:'数据库写入或一致性检查未能完成。请刷新后重试，持续失败时提供请求编号。',
        ERR_SQLITE_CONSTRAINT:'数据库写入发生数据约束冲突。请刷新并检查目标项目，持续失败时提供请求编号。',
        DISK_BUSY:'分区正在执行另一项管理任务。请等待任务结束。',
        DISK_UPLOAD_IN_PROGRESS:'目录中仍有上传任务，暂时不能执行此操作。请等待上传结束。',
        INVALID_CACHE_SCOPE:'缓存清理范围不合法，或按用户清理时没有指定用户。请重新选择清理范围。',
        INVALID_CACHE_CLEANUP_SCOPE:'缓存清理类型不合法。请选择残留缓存或已结束任务缓存。',
        STORAGE_BACKEND_UNAVAILABLE:'文件存储后端暂不可用，请联系管理员检查配置。',
        LOGIN_REQUIRED:'请先登录网盘。',
        SHARE_NOT_FOUND:'分享不存在、已停止或文件已不在分享范围内。请联系分享者。',
        DISK_DELETE_PARTIAL:'部分项目删除失败。请检查任务结果及剩余项目，不要重复执行整批操作。',
        TRASH_NOT_FOUND:'回收站项目已不存在或不属于当前分区。请刷新回收站。',
        DISK_SPACE_TRASH_NOT_EMPTY:'分区回收站仍有可还原项目。请先还原或永久删除这些项目，再删除分区。',
        TRASH_PURGE_CONFIRM_REQUIRED:'永久删除需要明确确认；此操作不能还原。',
        TRASH_PATH_INVALID:'只能在被删除目录的内部浏览，不能跳出该回收站项目。',
        TRASH_PARENT_MISSING:reasons.TRASH_PARENT_MISSING,
        TRASH_RESTORE_CONFLICT:reasons.TRASH_RESTORE_CONFLICT,
        TRASH_CONTENT_UNAVAILABLE:'被删除项目的正文已不可用，无法完整还原。请联系管理员检查存储。',
        'telegram-drive-folder-depth-exceeded':'目标目录层级超过允许上限。请选择较浅的目标目录。',
        'telegram-drive-folder-cycle':'不能把目录移动到自身或其子目录。请重新选择目标。',
        'telegram-drive-folder-not-found':'目录不存在或已被移动。请刷新列表。',
        'telegram-drive-destination-not-found':reasons.TARGET_UNAVAILABLE,
        'telegram-drive-file-not-found':'文件不存在或已被删除。请刷新列表。'
    };
    Object.assign(codes,{"S3_SPACE_ALREADY_MAPPED":"此分区已有后台 S3 Bucket 映射，请管理员统一管理，不能重复创建","DISK_SPACE_TRANSFER_INVALID":"目标分区无效，或与当前分区相同","INVITE_NOT_FOUND":"邀请链接已使用或已失效","DISK_BATCH_LIMIT":"每批请选择 1–100 个文件","USERNAME_INVALID":"账号名须为 3–64 位字母、数字、下划线、点或短横线","USERNAME_EXISTS":"账号名已被使用，请更换名称或选择登录","PASSKEY_ACCOUNT_NOT_FOUND":"该账号尚未在此域名注册 Passkey","PASSKEY_FLOW_INVALID":"验证已失效，请重新开始","PASSKEY_VERIFICATION_FAILED":"Passkey 验证失败，请重试","PASSKEY_SERVER_UNAVAILABLE":"服务端 Passkey 依赖缺失，请管理员在部署目录执行 npm ci 并重启服务","LOCAL_USE_OIDC_MOCK":"localhost 和局域网测试请使用 Telegram OIDC Mock","TELEGRAM_NETWORK_ERROR":"连接 Telegram 失败，请检查服务器网络","UPLOAD_CLIENT_NETWORK_ERROR":"浏览器与服务器之间的上传连接中断，请检查网络后重试","UPLOAD_CLIENT_REQUEST_FAILED":"客户端上传请求失败，服务器正在清理未完成的上传","UPLOAD_ACTIVE_LIMIT":"服务器已有 20 项渐进式上传正在执行，请等待部分任务完成后重试","TELEGRAM_UPLOAD_OUTCOME_UNKNOWN":"Telegram 发送结果未确认，已保留分片及消息记录；请先核对频道消息再重试","UPLOAD_FINAL_RESULT_UNKNOWN":"最终媒体组的发送结果未确认，已保留已推送分片；请先核对频道消息再重试","UPLOAD_SOURCE_INTERRUPTED":"服务重启时浏览器上传尚未完成，已保留分片记录；请重新上传","UPLOAD_RECOVERY_MANIFEST_MISSING":"上传恢复记录缺失，此任务无法自动继续；请重新上传","TELEGRAM_400":"Telegram 拒绝了当前文件发送请求","EPERM":"服务器写入上传暂存记录失败，请检查文件锁或目录权限","TELEGRAM_DELETE_NOT_PERMITTED":"Telegram 拒绝删除或替换消息，请检查频道权限及消息类型","TELEGRAM_CAPTION_SYNC_PENDING":"目录/名称已保存，部分 Telegram 备注同步失败，服务器将自动重试","TELEGRAM_UPLOAD_RESULT_INVALID":"Telegram 返回的消息缺少有效文件定位信息，上传未完成","TELEGRAM_413":"Telegram 拒绝当前上传请求的大小，请重试或检查 Bot API 代理限制","TELEGRAM_PARTS_INVALID":"文件分片索引不完整，无法还原文件","TELEGRAM_MESSAGE_MISSING":"文件索引缺少 Telegram 消息定位信息，无法删除实体","SERVER_RESTARTED":"服务已重启，此任务未完成，请重新执行","telegram-drive-folder-depth-exceeded":"目录层级超过管理员设置的上限","telegram-drive-folder-name-required":"请输入有效的文件夹名称","telegram-drive-folder-not-found":"文件夹不存在或已被移动","telegram-drive-destination-not-found":"目标文件夹不存在","telegram-drive-folder-cycle":"不能把文件夹移动到自身或其子目录中","telegram-drive-folder-exists":"目标位置已存在同名文件夹","telegram-drive-folder-not-empty":"文件夹不为空","telegram-drive-file-name-required":"请输入有效的文件名","telegram-drive-file-not-found":"文件不存在或已被删除","telegram-drive-delete-partial":"部分 Telegram 文件删除失败，未删除的记录已保留","telegram-drive-channel-not-configured":"管理员尚未配置网盘存储频道","telegram-drive-upload-size-invalid":"文件总大小为空或超过当前上传限制"});
    function describe(code,reason,context={}) {
        let text=reasons[reason]||codes[code]||'操作未能完成，请检查资源状态并刷新；持续失败时提供错误码及请求编号。';
        if(reason==='DESTINATION_INSIDE_SOURCE')text=`无法将目录“${String(context.sourcePath||'来源目录').slice(0,300)}”复制到“${String(context.targetPath||'目标目录').slice(0,300)}”：`+text;
        else if(context.targetPath&&['NAME_CONFLICT','NAME_PENDING_UPLOAD','PATH_BLOCKED_BY_FILE','STATIC_FILE_OPEN','STATIC_DIRECTORY_OPEN','MOUNT_IN_SOURCE','TRASH_PARENT_BLOCKED'].includes(reason))text=`位置“/${String(context.targetPath).slice(0,300)}”：`+text;
        return text;
    }
    function format(error) {
        const value=String(error?.code||error?.error||error?.message||error||'DISK_REQUEST_FAILED');
        const batch=error?.batchProgress;
        const progress=batch ? `\n在处理“${String(batch.item).slice(0,300)}”时中断。已确认完成 ${batch.completed}/${batch.total} 项，后续 ${batch.remaining} 项未执行。请检查当前项目及任务结果，不要重复执行整批操作。` : '';
        if(!/^[a-zA-Z0-9_-]{1,100}$/.test(value))return (value.startsWith('SQL')||/constraint|sqlite|node_modules|stack|[A-Z]:[\\/]|\bat \S+\([^)]*:\d+|\/bot\d+:[A-Za-z0-9_-]+/i.test(value)?describe('DISK_REQUEST_FAILED')+' [DISK_REQUEST_FAILED]':value)+progress;
        const uncertain=error?.errorDetails?.requestOutcomeUnknown||value==='TELEGRAM_NETWORK_ERROR'&&error?.errorDetails?.causeCode==='UND_ERR_HEADERS_TIMEOUT';
        const text=uncertain ? 'Telegram 发送结果未确认，已保留恢复资料；请先核对频道消息，勿直接重复上传。' : error?.userMessage||describe(value,error?.errorDetails?.reason,error?.errorDetails);
        return `${text} [${value}]`+(error?.errorDetails?.requestId?` · 请求编号：${error.errorDetails.requestId}`:'')+progress;
    }
    return {describe,format,codes,reasons};
});
