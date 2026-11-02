'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_LOG_BYTES = 512 * 1024;
const MAX_RECORD_BYTES = 4096;

function errorDetails(error) {
    const token = value => /^[A-Za-z0-9_.:-]{1,80}$/.test(String(value || '')) ? String(value) : 'unknown';
    try {
        // Keep source locations, never the error message, arguments or function
        // text: native spawn errors can include credentials from their arguments.
        const stack = String(error?.stack || '');
        const heading = String(error?.name || 'Error') + (error?.message ? ': ' + String(error.message) : '');
        const frames = (stack.startsWith(heading) ? stack.slice(heading.length).split(/\r?\n/) : []).flatMap(line => {
            const location = line.match(/^\s+at (?:.*? \()?([^()]+):(\d+):(\d+)\)?$/);
            if (!location) return [];
            const file = location[1].split(/[\\/]/).pop();
            if (!/^[A-Za-z0-9_.-]+$/.test(file)) return [];
            return [file + ':' + location[2] + ':' + location[3]];
        }).slice(0, 6);
        return 'name=' + token(error?.name) + ' code=' + token(error?.code) +
            (frames.length ? ' frames=' + frames.join(',') : '');
    } catch (_) { return 'name=unknown code=unknown'; }
}

function installProcessDiagnostics(options = {}) {
    const dataDir = path.resolve(options.dataDir || process.env.TUNNEL_DATA_DIR || path.join(__dirname, '..', '.tunnel-data'));
    const logPath = path.join(dataDir, 'server-process.log');
    let phase = 'bootstrap';
    let shutdownSignal = '';
    let warned = false;

    function stderr(line) {
        try { fs.writeSync(2, line); } catch (_) {}
    }
    function warning(error) {
        if (warned) return;
        warned = true;
        stderr('[server-diagnostics-warning] pid=' + process.pid + ' ' + errorDetails(error) + '\n');
    }
    function persist(line) {
        try {
            fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
            let size = 0;
            try { size = fs.statSync(logPath).size; }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            // Reserve two records for the existing proxy parent and child racing
            // between stat and append. Rotation races may drop an older segment;
            // they must never prevent either process from exiting.
            if (size + Buffer.byteLength(line) > MAX_LOG_BYTES - 2 * MAX_RECORD_BYTES) {
                try { fs.renameSync(logPath, logPath + '.1'); }
                catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
            fs.appendFileSync(logPath, line, { mode: 0o600 });
        } catch (error) { warning(error); }
    }
    function record(event, details, toStderr = false) {
        try {
            const memory = process.memoryUsage();
            const line = '[server-' + event + '] pid=' + process.pid + ' ' + details +
                ' uptime=' + Math.floor(process.uptime()) + 's time=' + new Date().toISOString() +
                ' ppid=' + process.ppid + ' phase=' + phase +
                ' rss=' + memory.rss + ' heapUsed=' + memory.heapUsed +
                ' heapTotal=' + memory.heapTotal + ' external=' + memory.external +
                ' arrayBuffers=' + memory.arrayBuffers + '\n';
            if (Buffer.byteLength(line) > MAX_RECORD_BYTES) return;
            if (toStderr) stderr(line);
            persist(line);
        } catch (error) { warning(error); }
    }
    const diagnostics = {
        setPhase(value) {
            if (!/^[a-z0-9-]{1,40}$/.test(value) || phase === value) return;
            phase = value;
            record('phase', '');
        },
        markShutdown(signal) {
            if (['SIGINT', 'SIGTERM', 'SIGHUP'].includes(signal)) shutdownSignal = signal;
            diagnostics.setPhase('shutdown');
        },
        proxyChildExit(child, code, signal) {
            record('proxy-exit', 'childPid=' + (child.pid || 'none') + ' code=' + (code ?? 'none') +
                ' signal=' + (signal || 'none'), true);
        },
        proxyChildError(child, error) {
            record('proxy-error', 'childPid=' + (child.pid || 'none') + ' ' + errorDetails(error), true);
        }
    };
    // A monitor observes fatal errors without suppressing Node's default exit.
    process.on('uncaughtExceptionMonitor', (error, origin) => {
        record('fatal', 'origin=' + origin + ' ' + errorDetails(error), true);
    });
    process.on('exit', code => {
        record('exit', 'code=' + code + ' signal=' + (shutdownSignal || 'none'), true);
    });
    record('start', 'node=' + process.version + ' platform=' + process.platform + ' arch=' + process.arch);
    return diagnostics;
}

module.exports = { installProcessDiagnostics };
