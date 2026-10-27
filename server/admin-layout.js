'use strict';
const path = require('node:path');
const ADMIN_PAGES = ['/admin', '/admin/home', '/admin/devices', '/admin/magnets', '/tgbot', '/sns-cookies', '/sns-dl', '/youtube-premium-dl', '/media-library', '/video-transcode', '/disk-management', '/s3-management', '/data-usage', '/system-backup', '/telegram-content', '/vclient', '/video-transcode-guide.html'];

function registerAdminLayout(app, { requireAuth, root }) {
    app.get('/admin/home', requireAuth, (_req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(path.join(root, 'pages', 'admin.html'));
    });
    app.get(['/admin/devices','/admin/magnets'], requireAuth, (req,res,next)=>{ if(req.query.admin_frame!=='1'&&req.get('Sec-Fetch-Dest')!=='iframe')return next();res.setHeader('Cache-Control','no-store');res.sendFile(path.join(root,'pages',req.path.endsWith('devices')?'admin-devices.html':'admin-magnets.html')); });
    app.use((req, res, next) => {
        if (!['GET', 'HEAD'].includes(req.method) || !ADMIN_PAGES.includes(req.path)) return next();
        requireAuth(req, res, () => {
            // Existing pages and their API/authentication logic remain intact.
            if (req.query.admin_frame === '1' || req.get('Sec-Fetch-Dest') === 'iframe') return next();
            res.setHeader('Cache-Control', 'no-store');
            res.sendFile(path.join(root, 'pages', 'admin-layout.html'));
        });
    });
}
module.exports = { registerAdminLayout, ADMIN_PAGES };
