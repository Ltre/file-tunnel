#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import Module from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(argv) {
  const args = { dist: 'dist', profile: '' };
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (item === '--dist') args.dist = argv[++index] || 'dist';
    else if (item === '--profile') args.profile = argv[++index] || '';
    else if (item === '--help' || item === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${item}`);
  }
  return args;
}

function usage() {
  return 'Usage: node tools/deploy/verify.mjs [--dist dist] [--profile txsl]';
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function exists(root, publicPath) {
  const clean = String(publicPath).replace(/[?#].*$/, '').replace(/^\/+/, '');
  try {
    await fs.access(path.join(root, clean));
    return true;
  } catch {
    // HTML routes are served from pages rather than the distribution root.
    if (!clean.includes('/') && clean.endsWith('.html')) {
      try { await fs.access(path.join(root, 'pages', clean)); return true; } catch {}
    }
    return false;
  }
}

function collectHtmlRefs(html) {
  const refs = [];
  // Read opening tags, skipping comments and raw script/style/text bodies.
  // Escaped examples in the help manuals are text, not loaded resources.
  const tags = /<!--[\s\S]*?-->|<(script|style|textarea|title)\b([^>]*)>[\s\S]*?<\/\1\s*>|<([a-z][\w:-]*)\b([^>]*)>/gi;
  for (const match of html.matchAll(tags)) {
    const attributes = match[2] ?? match[4];
    if (!attributes) continue;
    for (const attribute of attributes.matchAll(/\b(src|href)\s*=\s*["']([^"']+)["']/gi)) refs.push(attribute[2]);
  }
  // The entry page emits parser-loaded scripts with document.write. Validate
  // those literal tags too, without treating arbitrary JS strings as assets.
  for (const emitted of html.matchAll(/document\.write\(\s*(["'`])([\s\S]*?)\1\s*\)/g)) {
    for (const script of emitted[2].matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) refs.push(script[1].replace(/\$\{suffix\}/g, ''));
  }
  return refs;
}

function shouldExistAsStaticFile(ref) {
  if (ref.includes('${')) return false;
  if (!ref.startsWith('/')) return false;
  if (ref.startsWith('/socket.io/') || ref.startsWith('/api/')) return false;
  if (ref === '/' || ref.startsWith('/?')) return false;
  if (ref === '/manifest.webmanifest' || ref.startsWith('/manifest.webmanifest?')) return false;
  if (ref === '/runtime-config.js') return false;
  if (/^\/(?:admin|disk-management|s3-management|s3-api-guide|data-usage|tgbot|sns-cookies|sns-dl|youtube-premium-dl|downloader|downloadList|record|magnet|device|light-file-parts|telegram-content|video-transcode|vclient|web-zip-preview|disk)(?:[/?#]|$)/.test(ref)) return false;
  return true;
}

async function checkJavaScriptSyntax(distRoot, relativePath, commonJS = false) {
  const source = await fs.readFile(path.join(distRoot, relativePath), 'utf8');
  new vm.Script(commonJS ? Module.wrap(source) : source, { filename: relativePath });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const distRoot = path.resolve(ROOT, args.dist);
  const release = await readJson(path.join(distRoot, 'release.json'));
  const buildManifest = await readJson(path.join(distRoot, 'build-manifest.json'));
  const errors = [];

  if (args.profile && release.profile !== args.profile) {
    errors.push(`release profile ${release.profile} does not match expected ${args.profile}`);
  }
  if (!release.buildId || !release.sourceCommit || !release.serverPort) {
    errors.push('release.json is missing buildId, sourceCommit or serverPort');
  }
  if (!buildManifest.scripts || !buildManifest.appShell) {
    errors.push('build-manifest.json is missing scripts or appShell');
  }
  if (!buildManifest.scripts?.['client/simplewebauthn.js']) errors.push('missing Passkey browser bundle in release manifest');
  if (!buildManifest.scripts?.['client/disk-share.js']) errors.push('missing public disk-share script');
  if (!buildManifest.scripts?.['client/cache-store-worker.js']) errors.push('missing OPFS cache worker');
  if (!buildManifest.scripts?.['client/s3-management.js']) errors.push('missing S3 management script');
  if (!await exists(distRoot, '/docs/telegram-drive-s3-compatible.md')) errors.push('missing S3 API guide source');
  if ((buildManifest.appShell || []).some(ref => ref === '/s3-management' || ref === '/s3-api-guide' || ref === buildManifest.scripts?.['client/s3-management.js'] || ref === buildManifest.styles?.['s3-management'])) errors.push('S3 administration must not be in APP_SHELL');

  for (const [source, assetPath] of Object.entries(buildManifest.scripts || {})) {
    if (!/^\/assets\/.+\.[a-f0-9]{10}\.min\.js$/.test(assetPath)) {
      errors.push(`script ${source} is not a hashed min asset: ${assetPath}`);
    }
    if (!await exists(distRoot, assetPath)) errors.push(`missing script asset: ${assetPath}`);
  }

  for (const appShellPath of buildManifest.appShell || []) {
    if (appShellPath.startsWith('/assets/') || appShellPath === '/tunnel-icon.svg') {
      if (!await exists(distRoot, appShellPath)) errors.push(`APP_SHELL missing static asset: ${appShellPath}`);
    }
  }

  const pagesDir = path.join(distRoot, 'pages');
  const pages = (await fs.readdir(pagesDir)).filter(name => name.endsWith('.html'));
  for (const page of pages) {
    const html = await fs.readFile(path.join(pagesDir, page), 'utf8');
    for (const ref of collectHtmlRefs(html)) {
      if (ref.startsWith('/client/') || /^\/app\.js(?:[?]|$)/.test(ref)) errors.push(`page still references source asset: pages/${page}: ${ref}`);
      if (shouldExistAsStaticFile(ref) && !await exists(distRoot, ref)) {
        errors.push(`pages/${page} references missing file: ${ref}`);
      }
    }
  }

  const sw = await fs.readFile(path.join(distRoot, 'service-worker.js'), 'utf8');
  if (!sw.includes(`instant-tunnel-${release.buildId}`)) errors.push('service-worker cache name does not include buildId');
  if (/\/client\/|\/app\.js['"]/.test(sw)) errors.push('service-worker still caches source JS paths');
  for (const [source, assetPath] of Object.entries(buildManifest.scripts || {})) {
    if (source === 'client/s3-management.js') continue;
    if (!sw.includes(assetPath)) errors.push(`service-worker APP_SHELL missing ${assetPath}`);
  }

  await checkJavaScriptSyntax(distRoot, 'server.js', true);
  await checkJavaScriptSyntax(distRoot, 'service-worker.js');
  for (const assetPath of Object.values(buildManifest.scripts || {})) {
    await checkJavaScriptSyntax(distRoot, assetPath.replace(/^\//, ''));
  }

  if (errors.length) {
    console.error(`verify failed with ${errors.length} issue(s):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log(`verify ok: ${release.profile} ${release.buildId}`);
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
