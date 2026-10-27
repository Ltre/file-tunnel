(function (global) {
    'use strict';
    const rows = [
        ['音频', 'Audio'], ['音频文件', 'Audio file'], ['图片文件', 'Image file'], ['帖子 Markdown', 'Post Markdown'],
        ['网易云音乐', 'NetEase Cloud Music'],
        ['其它 SNS 媒体下载', 'Other SNS media downloads'],
        ['粘贴 SNS / B站 / 网易云音乐单曲、MV 或电台节目链接', 'Paste an SNS / Bilibili / NetEase song, music video or radio episode link'],
        ['本页仅使用 /sns-cookies 中对应平台的普通 Cookie；公开页面未配置 Cookie 时也会直接尝试。网易云音乐建议使用小号 Cookie；可下载音质和完整内容以该账号实际权限为准。解析不到的字段会保持为空。', 'This page uses ordinary platform cookies from /sns-cookies and also tries public pages without cookies. Use a secondary NetEase account cookie. Available quality and full content depend on the account permissions. Unavailable fields remain empty.'],
        ['建议使用网易云音乐小号的 Cookie；下载权限、音质及是否仅能获取试听片段，以该账号和平台实际返回为准。', 'Use a secondary NetEase account cookie. Download permissions, quality and possible preview-only access depend on the account and platform response.'],
        ['帖子转为 Markdown', 'Forward post as Markdown'],
        ['正在启动帖子转发…', 'Starting post transfer…'],
        ['正在获取帖子及媒体，完成后将显示在传输记录中', 'Fetching the post and media. The result will appear in transfer history when complete.'],
        ['帖子 Markdown 已保存到隧道', 'Post Markdown saved to the tunnel'],
        ['该帖子已转为 Markdown，请在传输记录中查看', 'This post has already been converted. View it in transfer history.'],
        ['当前设备没有读取、发送文本及文件的完整权限', 'This device needs permission to read and send text and files'],
        ['隧道连接已变化，请返回原隧道后重试', 'The tunnel connection changed. Return to the original tunnel and retry.'],
        ['原始帖子记录已删除或不可用', 'The source post record was deleted or is unavailable'],
        ['该帖子链接暂不支持抓取', 'This post link is not supported'],
        ['平台没有返回可读取的帖子内容，请检查对应平台 Cookie 后重试', 'The platform did not return readable post content. Check its cookie and retry.'],
        ['帖子媒体尚未成功保存到隧道，未生成 Markdown', 'The post media was not saved to the tunnel. No Markdown was generated.'],
        ['帖子图片读取失败，未生成 Markdown，请检查来源后重试', 'A post image could not be read. No Markdown was generated. Check the source and retry.'],
        ['帖子来源地址不允许访问', 'The post source address is not allowed'],
        ['读取帖子或媒体超时，请稍后重试', 'Reading the post or media timed out. Retry later.'],
        ['当前帖子抓取支持 HTTP、HTTPS 或 SOCKS5 出站代理，请检查服务端代理配置', 'Post fetching supports HTTP, HTTPS or SOCKS5 outbound proxies. Check the server proxy configuration.'],
        ['出站代理拒绝了连接，请检查服务端代理认证或连接配置', 'The outbound proxy rejected the connection. Check its authentication or connection settings.'],
        ['帖子图片数量超过本次处理上限，未生成 Markdown', 'The post exceeds the image limit. No Markdown was generated.'],
        ['帖子媒体数量超过本次处理上限，请使用单条帖子链接', 'The media count exceeds the limit. Use a single post link.'],
        ['当前正在处理的帖子较多，请稍后重试', 'Too many posts are being processed. Retry later.'],
        ['帖子内容过大，未生成 Markdown', 'The post is too large. No Markdown was generated.'],
        ['帖子转发失败，请检查平台 Cookie、网络和原帖是否可访问后重试', 'Post transfer failed. Check the platform cookie, network and source availability, then retry.']
    ];
    const catalog = global.Drop2TunnelI18nCatalog ||= {};
    for (const [source, en] of rows) if (!catalog[source]) catalog[source] = { en };
})(window);
