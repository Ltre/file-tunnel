'use strict';

const fs = require('fs');
const path = require('path');
const { VClientRuntime } = require('./runtime');

function argumentValue(argv, name) {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : '';
}

async function readControlToken(options = {}) {
    const direct = String(options.token || process.env.VCLIENT_TOKEN || process.env.VCLIENT_CONTROL_TOKEN || '').trim();
    if (direct) return direct;
    const tokenFile = options.tokenFile || process.env.VCLIENT_TOKEN_FILE || '';
    if (!tokenFile) throw new Error('请通过 VCLIENT_TOKEN 或 VCLIENT_TOKEN_FILE 配置缓存节点控制令牌');
    const token = String(await fs.promises.readFile(path.resolve(tokenFile), 'utf8')).trim();
    if (!token) throw new Error('缓存节点控制令牌文件为空');
    return token;
}

async function main(argv = process.argv.slice(2), environment = process.env) {
    let localPort = 80;
    try {
        const config = JSON.parse(await fs.promises.readFile(path.resolve('tunnel.config.json'), 'utf8'));
        localPort = Number(config?.serverPort) || localPort;
    } catch (_) {}
    const serverUrl = argumentValue(argv, '--server') || environment.VCLIENT_SERVER_URL || `http://127.0.0.1:${localPort}`;
    const dataDir = argumentValue(argv, '--data-dir') || environment.VCLIENT_DATA_DIR || path.resolve('.vclient-data');
    const tokenFile = argumentValue(argv, '--token-file') || environment.VCLIENT_TOKEN_FILE ||
        environment.VCLIENT_CONTROL_TOKEN_FILE || path.resolve('.tunnel-data', 'vclient-control.token');
    const token = await readControlToken({ token: environment.VCLIENT_TOKEN || environment.VCLIENT_CONTROL_TOKEN, tokenFile });
    if (!serverUrl) throw new Error('请通过 VCLIENT_SERVER_URL 或 --server 配置主服务地址');

    const runtime = new VClientRuntime({
        serverUrl,
        token,
        dataDir,
        controlNamespace: environment.VCLIENT_CONTROL_NAMESPACE || '/vclient-control'
    });
    await runtime.start();
    console.log(`[VClient] 已启动，主服务：${serverUrl}，独立缓存目录：${path.resolve(dataDir)}`);

    let stopping = false;
    const shutdown = async signal => {
        if (stopping) return;
        stopping = true;
        console.log(`[VClient] 收到 ${signal}，正在安全停止…`);
        await runtime.stop();
        process.exitCode = 0;
    };
    process.once('SIGINT', () => shutdown('SIGINT').catch(err => {
        console.error('[VClient] 停止失败：', err);
        process.exitCode = 1;
    }));
    process.once('SIGTERM', () => shutdown('SIGTERM').catch(err => {
        console.error('[VClient] 停止失败：', err);
        process.exitCode = 1;
    }));
    return runtime;
}

if (require.main === module) {
    main().catch(err => {
        console.error(`[VClient] 启动失败：${err.message}`);
        process.exitCode = 1;
    });
}

module.exports = { main, readControlToken, argumentValue };
