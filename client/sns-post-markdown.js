(function (global) {
    'use strict';
    const observedSockets = new WeakSet();
    const t = value => global.TunnelI18n?.t(value) || value;
    const escape = value => String(value || '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
    const errors = {
        'permission-denied': '当前设备没有读取、发送文本及文件的完整权限',
        'invalid-session': '隧道连接已变化，请返回原隧道后重试',
        SNS_POST_SOURCE_MISSING: '原始帖子记录已删除或不可用',
        SNS_POST_URL_UNSUPPORTED: '该帖子链接暂不支持抓取',
        SNS_POST_CONTENT_UNAVAILABLE: '平台没有返回可读取的帖子内容，请检查对应平台 Cookie 后重试',
        SNS_POST_MEDIA_UNAVAILABLE: '帖子媒体尚未成功保存到隧道，未生成 Markdown',
        SNS_POST_IMAGE_INVALID: '帖子图片读取失败，未生成 Markdown，请检查来源后重试',
        SNS_POST_ADDRESS_DENIED: '帖子来源地址不允许访问',
        SNS_POST_TIMEOUT: '读取帖子或媒体超时，请稍后重试',
        SNS_POST_PROXY_UNSUPPORTED: '当前帖子抓取支持 HTTP、HTTPS 或 SOCKS5 出站代理，请检查服务端代理配置',
        SNS_POST_PROXY_REJECTED: '出站代理拒绝了连接，请检查服务端代理认证或连接配置',
        SNS_POST_IMAGE_LIMIT: '帖子图片数量超过本次处理上限，未生成 Markdown',
        SNS_POST_MEDIA_LIMIT: '帖子媒体数量超过本次处理上限，请使用单条帖子链接',
        SNS_POST_BUSY: '当前正在处理的帖子较多，请稍后重试',
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
    function bind(container, message, { request, sessionId, socket, toast }) {
        if (socket && !observedSockets.has(socket)) {
            observedSockets.add(socket);
            socket.on('sns-post-markdown-result', result => {
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
                    toast(result.started ? t('正在获取帖子及媒体，完成后将显示在传输记录中') : t('该帖子已转为 Markdown，请在传输记录中查看'));
                } catch (error) { toast(errorText(error.message)); }
                finally { button.disabled = false; button.textContent = original; }
            });
        });
    }
    global.SnsPostMarkdown = { action, bind, errorText };
})(window);
