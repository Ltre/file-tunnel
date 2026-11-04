(function (global) {
    'use strict';
    const observedSockets = new WeakSet();
    const t = value => global.TunnelI18n?.t(value) || value;
    const escape = value => String(value || '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
    const errors = {
        'permission-denied': '当前设备没有读取、发送Markdown及文件的完整权限',
        'invalid-session': '隧道连接已变化，请返回原隧道后重试',
        SNS_X_AUTHOR_SUSPENDED: '原帖发布账号已被 X 停用，当前无法读取该帖子；这不代表当前登录账号被停用',
        SNS_POST_SOURCE_MISSING: '原始帖子记录已删除或不可用',
        SNS_POST_URL_UNSUPPORTED: '该帖子链接暂不支持抓取',
        SNS_POST_CONTENT_UNAVAILABLE: '平台没有返回可读取的帖子内容，请检查对应平台 Cookie 后重试',
        SNS_POST_MEDIA_UNAVAILABLE: '帖子媒体尚未成功保存到隧道，未生成 Markdown',
        SNS_POST_MEDIA_INCOMPLETE: '仍有帖子媒体无法读取，未生成完整 Markdown；请检查 X Cookie、网络或服务端浏览器后重试',
        SNS_POST_IMAGE_INVALID: '帖子图片读取失败，未生成 Markdown，请检查来源后重试',
        SNS_POST_ADDRESS_DENIED: '帖子来源地址不允许访问',
        SNS_POST_TIMEOUT: '读取帖子或媒体超时，请稍后重试',
        SNS_POST_PROXY_UNSUPPORTED: '当前帖子抓取支持 HTTP、HTTPS 或 SOCKS5 出站代理，请检查服务端代理配置',
        SNS_POST_PROXY_REJECTED: '出站代理拒绝了连接，请检查服务端代理认证或连接配置',
        SNS_POST_IMAGE_LIMIT: '帖子图片数量超过本次处理上限，未生成 Markdown',
        SNS_POST_MEDIA_LIMIT: '帖子媒体数量超过本次处理上限，请使用单条帖子链接',
        SNS_POST_BUSY: '当前正在处理的帖子较多，请稍后重试',
        SNS_POST_INTERRUPTED: '生成任务已中断，请在原帖记录中重试',
        SNS_POST_PLACEHOLDER_REMOVED: '生成中的记录已删除',
        SNS_POST_FAILED: '生成未完成，请检查网络和原帖是否可访问后重试',
        SNS_POST_CONTENT_TOO_LARGE: '帖子内容过大，未生成 Markdown'
    };
    function errorText(error) {
        const code = String(error || 'SNS_POST_FAILED');
        return t(errors[code] || '帖子转发失败，请检查平台 Cookie、网络和原帖是否可访问后重试') + ' [' + code.slice(0, 240) + ']';
    }
    function action(source) {
        if (!source?.id || !source?.sourceUrl) return '';
        return '<div class="sns-media-actions"><button type="button" data-sns-post-markdown="' + escape(source.id) + '">' +
            escape(t('帖子转为 Markdown')) + '</button></div>';
    }
    function renderProgress(container, progress) {
        if (!container || !progress) return;
        container.classList.add('sns-markdown-progress');
        container.setAttribute('role', 'status');
        const phases = { inspect: '正在解析帖子', framework: '正在整理文档框架', resources: '正在保存引用资源',
            publishing: '正在生成 Markdown 记录', failed: '生成 Markdown 未完成' };
        const resources = { image: '正在保存图片', video: '正在保存视频', audio: '正在保存音频', avatar: '正在保存作者头像' };
        const title = document.createElement('strong');
        title.textContent = t(phases[progress.stage] || '正在生成 Markdown 记录');
        const framework = document.createElement('span');
        framework.textContent = t(progress.frameworkReady ? '文档框架已就绪' : progress.stage === 'failed' ? '文档框架尚未就绪' : '文档框架准备中');
        const tally = document.createElement('span');
        const known = Number.isSafeInteger(progress.total) && progress.total >= 0;
        const count = known ? `${progress.done}/${progress.total}` : t('待确认');
        tally.textContent = t('引用资源') + ' ' + count;
        container.replaceChildren(title, framework, tally);
        if (progress.stage === 'failed') {
            const reason = document.createElement('span');
            reason.textContent = errorText(progress.error);
            container.append(reason);
        } else if (!known || progress.total > 0) {
            const bar = document.createElement('progress');
            bar.setAttribute('aria-label', t('引用资源'));
            if (known) { bar.max = progress.total; bar.value = progress.done; }
            container.append(bar);
            if (progress.resource && resources[progress.resource]) {
                const activity = document.createElement('span');
                activity.textContent = t(resources[progress.resource]);
                container.append(activity);
            }
        }
    }
    function bind(container, message, { request, sessionId, socket, toast, showRecord, currentSession }) {
        if (socket && !observedSockets.has(socket)) {
            observedSockets.add(socket);
            socket.on('sns-post-markdown-result', result => {
                if (currentSession && result?.sessionId !== currentSession()) return;
                toast(result?.ok ? t('帖子 Markdown 已保存到隧道') : errorText(result?.error));
            });
        }
        container.querySelectorAll('[data-sns-post-markdown]').forEach(button => {
            button.addEventListener('click', async event => {
                event.preventDefault(); event.stopPropagation();
                button.disabled = true;
                const original = button.textContent;
                button.textContent = t('正在启动帖子转发…');
                try {
                    const result = await request('sns-post-markdown', { sessionId, messageId: message.id, sourceId: button.dataset.snsPostMarkdown });
                    if (!result?.ok) throw Error(result?.error || 'SNS_POST_FAILED');
                    toast(result.started ? t('正在生成帖子 Markdown，请在传输记录中查看进度') : t('该帖子已转为 Markdown，请在传输记录中查看'));
                    showRecord?.(result.messageId);
                } catch (error) { toast(errorText(error.message)); }
                finally { button.disabled = false; button.textContent = original; }
            });
        });
    }
    global.SnsPostMarkdown = { action, bind, errorText, renderProgress };
})(window);
