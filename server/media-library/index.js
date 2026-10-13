'use strict';
const path = require('node:path');
const { createMediaDiskAdapter } = require('./disk-adapter');
const { createMediaLibrary } = require('./service');
const { createMediaProcessing } = require('./processing');
const { createMediaRoutes } = require('./routes');
function registerMediaLibrary(app, { dataDir, root, diskAPI, auth, backend, downloads, identity, requireAuth, origin, ffmpeg, ffprobe }) {
    const disk = createMediaDiskAdapter({ dataDir, diskAPI, auth, backend });
    const processing = createMediaProcessing({ ffmpeg, ffprobe });
    const service = createMediaLibrary({ dataDir, disk, downloads, processing });
    app.get(['/media-library', '/pages/media-library.html'], requireAuth, (req, res) => {
        res.set('Cache-Control', 'no-store'); res.sendFile(path.join(root, 'pages', 'media-library.html'));
    });
    app.get('/api/media-library/help', requireAuth, (req, res) => res.type('text/markdown').sendFile(path.join(root, 'docs', 'media-library.md')));
    app.use('/api/media-library', createMediaRoutes({ service, disk, downloads, identity, requireAuth, origin }));
    return service;
}
module.exports = { registerMediaLibrary };
