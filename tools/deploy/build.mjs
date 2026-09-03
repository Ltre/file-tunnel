#!/usr/bin/env node
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_OUT_DIR = 'dist';
const SCRIPT_SOURCES = [
  'app.js',
  'client/cache-store.js',
  'client/file-assets.js',
  'client/folder-archive.js',
  'client/media.js',
  'client/device-camera.js',
  'client/light-transfer.js',
  'client/telegram-drive-cache.js',
  'client/disk-client.js',
  'client/disk-ui.js',
  'client/disk-share.js',
  'client/disk-tunnel-adapter.js',
  'client/disk-admin.js',
  'client/disk-management.js',
  'client/simplewebauthn.js',
  'client/sns-download-cache.js',
  'client/i18n-catalog.js',
  'client/i18n.js',
  'client/localization-runtime.js',
  'client/youtube-premium-cache.js',
  'client/qrcode-1.0.0.min.js'
];
const PAGE_ROUTES = {
  'index.html': ['/', '/index.html'],
  'admin.html': ['/admin'],
  'disk-management.html': ['/disk-management'],
  'admin-auth.html': ['/admin-auth', '/admin-auth.html', '/admin.html'],
  'downloader.html': ['/downloader', '/downloader.html'],
  'downloadList.html': ['/downloadList', '/downloadList.html'],
  'device.html': ['/device.html'],
  'light-file-parts.html': ['/light-file-parts', '/light-file-parts.html'],
  'tgbot.html': ['/tgbot']
};

function parseArgs(argv) {
  const args = { profile: '', outDir: DEFAULT_OUT_DIR, sourceBranch: '', sourceCommit: '', dryRun: false };
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (item === '--profile') args.profile = argv[++index] || '';
    else if (item === '--out') args.outDir = argv[++index] || DEFAULT_OUT_DIR;
    else if (item === '--source-branch') args.sourceBranch = argv[++index] || '';
    else if (item === '--source-commit') args.sourceCommit = argv[++index] || '';
    else if (item === '--dry-run') args.dryRun = true;
    else if (item === '--help' || item === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${item}`);
  }
  return args;
}

function usage() {
  return `Usage: node tools/deploy/build.mjs --profile <txsl|txhk|alyhk> [--out dist] [--source-branch dev/2607A] [--source-commit <sha>]`;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function hashContent(content, length = 10) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, length);
}

function formatBuildTimestamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

function getGitValue(args) {
  try {
    const command = process.platform === 'win32' ? 'cmd.exe' : 'git';
    const commandArgs = process.platform === 'win32' ? ['/c', 'git', ...args] : args;
    return execFileSync(command, commandArgs, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return getGitValueFromFiles(args);
  }
}

function getGitDir() {
  const dotGit = path.join(ROOT, '.git');
  try {
    const stat = fsSync.statSync(dotGit);
    if (stat.isDirectory()) return dotGit;
    const content = fsSync.readFileSync(dotGit, 'utf8').trim();
    const match = content.match(/^gitdir:\s*(.+)$/i);
    if (!match) return '';
    return path.resolve(ROOT, match[1]);
  } catch {
    return '';
  }
}

function getGitValueFromFiles(args) {
  const gitDir = getGitDir();
  if (!gitDir) return '';
  try {
    const head = fsSync.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const refMatch = head.match(/^ref:\s*(.+)$/);
    if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') {
      return refMatch ? refMatch[1].replace(/^refs\/heads\//, '') : 'HEAD';
    }
    if (args.join(' ') === 'rev-parse HEAD') {
      if (!refMatch) return head;
      const refPath = path.join(gitDir, refMatch[1].replace(/\//g, path.sep));
      if (fsSync.existsSync(refPath)) return fsSync.readFileSync(refPath, 'utf8').trim();
      const packedRefsPath = path.join(gitDir, 'packed-refs');
      if (fsSync.existsSync(packedRefsPath)) {
        const packed = fsSync.readFileSync(packedRefsPath, 'utf8').split(/\r?\n/);
        const row = packed.find(line => line.endsWith(` ${refMatch[1]}`));
        if (row) return row.split(/\s+/)[0];
      }
    }
  } catch {
    return '';
  }
  return '';
}

async function loadProfile(id) {
  if (!/^[a-z0-9_-]+$/i.test(id || '')) throw new Error('Profile id is required.');
  const profilePath = path.join(ROOT, 'tools', 'deploy', 'profiles', `${id}.json`);
  const profile = JSON.parse(await fs.readFile(profilePath, 'utf8'));
  const required = ['id', 'deployBranch', 'domain', 'serverPort', 'pwaName', 'pwaShortName'];
  for (const key of required) {
    if (profile[key] === undefined || profile[key] === '') throw new Error(`Profile ${id} is missing ${key}.`);
  }
  if (!Number.isInteger(Number(profile.serverPort)) || Number(profile.serverPort) <= 0) {
    throw new Error(`Profile ${id} has invalid serverPort.`);
  }
  return profile;
}

async function resetDir(targetDir) {
  const resolved = path.resolve(ROOT, targetDir);
  if (!resolved.startsWith(`${ROOT}${path.sep}`)) throw new Error(`Refusing to clean outside project: ${resolved}`);
  if (path.basename(resolved) !== path.basename(targetDir)) throw new Error(`Unexpected output directory: ${resolved}`);
  try {
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  } catch (err) {
    if (!['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
    console.warn(`Warning: could not fully clean ${targetDir} (${err.code}); overwriting current build files and leaving old hashed assets in place.`);
  }
  await fs.mkdir(resolved, { recursive: true });
  return resolved;
}

async function copyFileRelative(source, outRoot, target = source) {
  const from = path.join(ROOT, source);
  const to = path.join(outRoot, target);
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
}

async function copyDirRelative(source, outRoot, target = source) {
  const from = path.join(ROOT, source);
  const to = path.join(outRoot, target);
  await fs.mkdir(to, { recursive: true });
  const entries = await fs.readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const childSource = path.join(source, entry.name);
    const childTarget = path.join(target, entry.name);
    if (entry.isDirectory()) await copyDirRelative(childSource, outRoot, childTarget);
    else if (entry.isFile()) await copyFileRelative(childSource, outRoot, childTarget);
  }
}

async function optionalImport(packageName) {
  try {
    return await import(packageName);
  } catch {
    return null;
  }
}

async function minifyJs(source, sourcePath, minifierState) {
  if (minifierState.terser === undefined) minifierState.terser = await optionalImport('terser');
  if (minifierState.terser?.minify) {
    try {
      const result = await minifierState.terser.minify(source, {
        ecma: 2018,
        compress: {
          passes: 1,
          unsafe: false,
          drop_console: false
        },
        mangle: {
          toplevel: false
        },
        format: {
          comments: false
        },
        sourceMap: false
      });
      if (result?.code) {
        minifierState.js = 'terser-local-mangle';
        return result.code;
      }
    } catch (err) {
      minifierState.terserError = err.message || String(err);
    }
  }

  if (minifierState.esbuild === undefined) minifierState.esbuild = await optionalImport('esbuild');
  if (!minifierState.esbuild?.transform) {
    minifierState.js = 'none';
    if (minifierState.terserError) minifierState.jsError = minifierState.terserError;
    return source;
  }
  try {
    const result = await minifierState.esbuild.transform(source, {
      loader: 'js',
      target: 'es2018',
      minifyWhitespace: true,
      minifySyntax: true,
      minifyIdentifiers: false,
      legalComments: 'none',
      sourcefile: sourcePath
    });
    minifierState.js = 'esbuild-whitespace-syntax';
    return result.code;
  } catch (err) {
    minifierState.js = 'none';
    minifierState.jsError = minifierState.terserError || err.message || String(err);
    return source;
  }
}

function minifyCss(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}:;,>+~])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim();
}

async function minifyHtml(source, minifierState) {
  if (minifierState.html === undefined) minifierState.html = await optionalImport('html-minifier-terser');
  if (!minifierState.html?.minify) return source;
  minifierState.htmlMode = 'html-minifier-terser';
  return minifierState.html.minify(source, {
    collapseWhitespace: true,
    conservativeCollapse: true,
    removeComments: true,
    removeRedundantAttributes: true,
    removeScriptTypeAttributes: true,
    removeStyleLinkTypeAttributes: true,
    useShortDoctype: true,
    removeOptionalTags: false,
    removeAttributeQuotes: false,
    removeEmptyElements: false,
    minifyCSS: false,
    minifyJS: false
  });
}

function assetNameForScript(source, content) {
  const parsed = path.parse(source.replace(/\\/g, '/'));
  const base = parsed.name.endsWith('.min') ? parsed.name.slice(0, -4) : parsed.name;
  return `assets/${base}.${hashContent(content)}.min.js`;
}

function publicPath(assetPath) {
  return `/${assetPath.replace(/\\/g, '/')}`;
}

async function buildScripts(outRoot, minifierState) {
  const assets = {};
  const stats = [];
  for (const source of SCRIPT_SOURCES) {
    const sourcePath = path.join(ROOT, source === 'client/simplewebauthn.js'
      ? 'node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js'
      : source);
    const raw = await fs.readFile(sourcePath, 'utf8');
    const built = await minifyJs(raw, source, minifierState);
    const assetPath = assetNameForScript(source, built);
    await fs.mkdir(path.join(outRoot, 'assets'), { recursive: true });
    await fs.writeFile(path.join(outRoot, assetPath), built);
    assets[source] = publicPath(assetPath);
    stats.push(sizeStat(source, assetPath, raw, built));
  }
  return { assets, stats };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceScriptReferences(html, assets) {
  let next = html;
  for (const [source, target] of Object.entries(assets)) {
    const sourceUrl = `/${source.replace(/\\/g, '/')}`;
    const pattern = new RegExp(`(["'\`])${escapeRegExp(sourceUrl)}(?:\\?[^"'\`<>]*)?\\1`, 'g');
    next = next.replace(pattern, (match, quote) => `${quote}${target}${quote}`);
    next = next.split(`${sourceUrl}\${suffix}`).join(`${target}\${suffix}`);
    next = next.split(`${sourceUrl}${'${suffix}'}`).join(`${target}${'${suffix}'}`);
  }
  return next;
}

function extractPageStyles(html, pageName, outRoot, styles) {
  const blocks = [];
  const withoutStyles = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (match, css) => {
    blocks.push(css);
    return '';
  });
  if (!blocks.length) return { html, writes: [] };
  const rawCss = blocks.join('\n');
  const builtCss = minifyCss(rawCss);
  const assetPath = `assets/${pageName}.${hashContent(builtCss)}.min.css`;
  styles[pageName] = publicPath(assetPath);
  const link = `<link rel="stylesheet" href="${publicPath(assetPath)}">`;
  const htmlWithLink = /<\/head>/i.test(withoutStyles)
    ? withoutStyles.replace(/<\/head>/i, `    ${link}\n</head>`)
    : `${link}\n${withoutStyles}`;
  return {
    html: htmlWithLink,
    writes: [{ assetPath, raw: rawCss, built: builtCss }]
  };
}

async function buildPages(outRoot, scriptAssets, buildId, minifierState) {
  const pagesDir = path.join(ROOT, 'pages');
  const pageFiles = (await fs.readdir(pagesDir)).filter(name => name.endsWith('.html'));
  const styles = {};
  const stats = [];
  const builtPages = [];
  for (const pageFile of pageFiles) {
    const sourcePath = path.join(pagesDir, pageFile);
    const rawHtml = await fs.readFile(sourcePath, 'utf8');
    let html = replaceScriptReferences(rawHtml, scriptAssets);
    if (html.includes('href="/client/disk.css"')) {
      const diskCss = await fs.readFile(path.join(ROOT, 'client/disk.css'), 'utf8');
      html = html.replace(/<link\b[^>]*href="\/client\/disk\.css"[^>]*>/, '<style>' + diskCss + '</style>');
    }
    html = html.replace(/href="\/manifest\.webmanifest(?:\?[^"]*)?"/g, `href="/manifest.webmanifest?v=${buildId}"`);
    const pageName = path.parse(pageFile).name;
    const extracted = extractPageStyles(html, pageName, outRoot, styles);
    html = extracted.html;
    for (const write of extracted.writes) {
      await fs.mkdir(path.dirname(path.join(outRoot, write.assetPath)), { recursive: true });
      await fs.writeFile(path.join(outRoot, write.assetPath), write.built);
      stats.push(sizeStat(`pages/${pageFile}:style`, write.assetPath, write.raw, write.built));
    }
    html = await minifyHtml(html, minifierState);
    const target = path.join(outRoot, 'pages', pageFile);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, html);
    if (pageFile === 'index.html') await fs.writeFile(path.join(outRoot, 'index.html'), html);
    stats.push(sizeStat(`pages/${pageFile}`, `pages/${pageFile}`, rawHtml, html));
    builtPages.push(pageFile);
  }
  return { styles, stats, builtPages };
}

function renderTemplate(template, values) {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key) => {
    if (values[key] === undefined) throw new Error(`Missing template value: ${key}`);
    return String(values[key]);
  });
}

function createManifest(profile) {
  const base = {
    name: profile.pwaName,
    short_name: profile.pwaShortName,
    description: '在同一个传输隧道中的设备间发送文件、消息和协同内容。',
    start_url: '/?pwa=1',
    scope: '/',
    display: 'standalone',
    background_color: '#f4f6fb',
    theme_color: '#4f5ec2',
    icons: [
      { src: '/tunnel-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
    ],
    share_target: {
      action: '/share/',
      method: 'POST',
      enctype: 'multipart/form-data',
      params: {
        title: 'title',
        text: 'text',
        url: 'url',
        files: [{ name: 'shared_file', accept: ['*/*'] }]
      }
    }
  };
  return { [profile.domain]: base, default: base };
}

async function writeGeneratedConfig(outRoot, profile, release) {
  const values = { ...profile, ...release };
  const templateDir = path.join(ROOT, 'tools', 'deploy', 'templates');
  const tunnelTemplate = await fs.readFile(path.join(templateDir, 'tunnel.config.json.tpl'), 'utf8');
  await fs.writeFile(path.join(outRoot, 'tunnel.config.json'), renderTemplate(tunnelTemplate, values));
  await fs.writeFile(path.join(outRoot, 'manifest.hosts.json'), `${JSON.stringify(createManifest(profile), null, 2)}\n`);
  await fs.mkdir(path.join(outRoot, 'deploy'), { recursive: true });
  if (profile.nginxEnabled) {
    const nginxTemplate = await fs.readFile(path.join(templateDir, 'nginx.conf.tpl'), 'utf8');
    await fs.writeFile(path.join(outRoot, 'deploy', `${profile.id}.nginx.conf`), renderTemplate(nginxTemplate, values));
  }
  const systemdTemplate = await fs.readFile(path.join(templateDir, 'systemd.service.tpl'), 'utf8');
  await fs.writeFile(path.join(outRoot, 'deploy', `${profile.id}.service`), renderTemplate(systemdTemplate, values));
  await fs.writeFile(path.join(outRoot, 'start.sh'), `#!/bin/sh\nset -eu\nprintf 'Starting Drop2Tunnel on port ${profile.serverPort}\\n'\nexec node server.js\n`);
  await fs.writeFile(path.join(outRoot, 'start.bat'), `@echo off\r\necho Starting Drop2Tunnel on port ${profile.serverPort}\r\nnode server.js\r\n`);
}

async function buildServiceWorker(outRoot, buildId, assets) {
  const raw = await fs.readFile(path.join(ROOT, 'service-worker.js'), 'utf8');
  const assetShell = Object.values(assets).sort();
  const pageShell = Object.values(PAGE_ROUTES).flat();
  const appShell = Array.from(new Set([
    ...pageShell,
    '/runtime-config.js',
    '/manifest.webmanifest',
    '/tunnel-icon.svg',
    ...assetShell
  ]));
  let built = raw.replace(/const CACHE_NAME = ['"][^'"]+['"];/, `const CACHE_NAME = 'instant-tunnel-${buildId}';`);
  built = built.replace(/const APP_SHELL = \[[\s\S]*?\];/, `const APP_SHELL = ${JSON.stringify(appShell, null, 4)};`);
  await fs.writeFile(path.join(outRoot, 'service-worker.js'), built);
  return { appShell, stat: sizeStat('service-worker.js', 'service-worker.js', raw, built) };
}

function sizeStat(source, output, raw, built) {
  const rawBuffer = Buffer.from(raw);
  const builtBuffer = Buffer.from(built);
  return {
    source,
    output,
    rawBytes: rawBuffer.length,
    builtBytes: builtBuffer.length,
    gzipBytes: gzipSync(builtBuffer).length
  };
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const profile = await loadProfile(args.profile);
  const sourceBranch = args.sourceBranch || getGitValue(['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown';
  const sourceCommit = args.sourceCommit || getGitValue(['rev-parse', 'HEAD']) || 'unknown';
  const buildId = `${profile.id}-${formatBuildTimestamp()}-${sourceCommit.slice(0, 8)}`;
  const outRoot = await resetDir(args.outDir);
  const minifierState = {};
  const stats = [];

  await copyFileRelative('server.js', outRoot);
  await copyFileRelative('package.json', outRoot);
  if (await pathExists(path.join(ROOT, 'package-lock.json'))) await copyFileRelative('package-lock.json', outRoot);
  await copyFileRelative('tunnel-icon.svg', outRoot);
  await copyDirRelative('server', outRoot);

  const scriptResult = await buildScripts(outRoot, minifierState);
  stats.push(...scriptResult.stats);
  const pageResult = await buildPages(outRoot, scriptResult.assets, buildId, minifierState);
  stats.push(...pageResult.stats);
  const swResult = await buildServiceWorker(outRoot, buildId, scriptResult.assets);
  stats.push(swResult.stat);

  const release = {
    buildId,
    profile: profile.id,
    deployBranch: profile.deployBranch,
    sourceBranch,
    sourceCommit,
    builtAt: new Date().toISOString(),
    domain: profile.domain,
    serverPort: Number(profile.serverPort),
    nginxEnabled: Boolean(profile.nginxEnabled)
  };
  await writeGeneratedConfig(outRoot, profile, release);

  const buildManifest = {
    ...release,
    scripts: scriptResult.assets,
    styles: pageResult.styles,
    pages: pageResult.builtPages,
    appShell: swResult.appShell,
    minifiers: {
      js: minifierState.js || 'none',
      html: minifierState.htmlMode || 'none',
      css: 'built-in-conservative'
    },
    stats
  };
  await writeJson(path.join(outRoot, 'release.json'), release);
  await writeJson(path.join(outRoot, 'build-manifest.json'), buildManifest);

  const rawTotal = stats.reduce((sum, item) => sum + item.rawBytes, 0);
  const builtTotal = stats.reduce((sum, item) => sum + item.builtBytes, 0);
  const gzipTotal = stats.reduce((sum, item) => sum + item.gzipBytes, 0);
  console.log(`Built ${profile.id} -> ${path.relative(ROOT, outRoot)}`);
  console.log(`Build id: ${buildId}`);
  console.log(`Static bytes: ${rawTotal} -> ${builtTotal}, gzip total ${gzipTotal}`);
  if (!minifierState.js || minifierState.js === 'none') {
    const reason = minifierState.jsError ? ` (${minifierState.jsError})` : '';
    console.log(`JS minifier unavailable${reason}; hashed assets and cache strategy were still generated.`);
  }
}

main().then(() => {
  process.exit(0);
}).catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
