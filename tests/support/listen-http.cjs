'use strict';
const { randomInt } = require('node:crypto');

// Explicit high loopback ports keep fetch fixtures away from restricted service ports.
async function listenHttp(app) {
    for (let attempt = 0; attempt < 30; attempt++) {
        const server = app.listen(randomInt(20000, 60000), '127.0.0.1');
        try {
            await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
            return server;
        } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
    }
    throw new Error('TEST_HTTP_PORT_UNAVAILABLE');
}
module.exports = { listenHttp };
