import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.join(root, 'chrome');
const targets = ['firefox-windows', 'firefox-android'];
const sharedFiles = ['background.js', 'options.html', 'options.js', 'sns-opened.js'];

for (const target of targets) {
    const targetDir = path.join(root, target);
    await mkdir(targetDir, { recursive: true });
    for (const file of sharedFiles) {
        await copyFile(path.join(sourceDir, file), path.join(targetDir, file));
    }
}

const manifests = Object.fromEntries(await Promise.all(['chrome', ...targets].map(async target => [
    target,
    JSON.parse(await readFile(path.join(root, target, 'manifest.json'), 'utf8'))
])));
if (!manifests.chrome.background?.service_worker) throw new Error('Chrome build must use a service worker.');
if (!manifests['firefox-windows'].background?.scripts) throw new Error('Firefox Windows build must use background scripts.');
if (manifests['firefox-android'].manifest_version !== 2) throw new Error('Firefox Android build must use Manifest V2.');

console.log(`Synced ${sharedFiles.length} shared files into ${targets.length} Firefox builds.`);
