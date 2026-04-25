#!/usr/bin/env node
/**
 * Local extraction script - Run without GitHub Actions
 *
 * Usage:
 *   node local-extract.mjs --version 2.1.119
 *   node local-extract.mjs --latest
 *   node local-extract.mjs --version 2.1.119 --output ./dist --no-verify
 */

import { mkdir, rm, writeFile, stat, copyFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { extractBunSEA } from './bun-sea-extract.mjs';
import { patchFile } from './node-compat-patch.mjs';
import { buildPlatformPackage } from './build-platform-package.mjs';
import { buildMainPackage } from './build-main-package.mjs';
import { verifyNodeCompat } from './verify-node-compat.mjs';

// ──────────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────────

const CDN_BASE = 'https://downloads.claude.ai/claude-code-releases';

const SEA_PLATFORMS = [
  'darwin-arm64', 'darwin-x64',
  'linux-arm64', 'linux-x64',
  'linux-arm64-musl', 'linux-x64-musl',
  'win32-arm64', 'win32-x64',
];

const OUTPUT_PLATFORMS = [...SEA_PLATFORMS, 'android-arm64'];
const PLATFORM_ALIAS = { 'android-arm64': 'linux-arm64' };
const DEFAULT_RG_VERSION = '14.1.1';

// Current platform detection
const CURRENT_PLATFORM = `${process.platform}-${process.arch}`;

// ──────────────────────────────────────────────
//  Download helpers
// ──────────────────────────────────────────────

function tarExtract(tgzPath, destDir, stripComponents, patterns) {
  const args = ['xzf', tgzPath, '-C', destDir];
  if (stripComponents) args.push(`--strip-components=${stripComponents}`);
  try {
    execFileSync('tar', [...args, ...patterns], { stdio: 'pipe' });
  } catch {
    execFileSync('tar', [...args, '--wildcards', ...patterns], { stdio: 'pipe' });
  }
}

function fetchJson(url) {
  return JSON.parse(execFileSync('curl', ['-sL', '--fail', url], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024,
  }));
}

async function downloadFile(url, destPath) {
  console.log(`  ↓ ${url.split('/').slice(-2).join('/')}`);
  execFileSync('curl', ['-sL', '--fail', '-o', destPath, url], { timeout: 600_000 });
  return (await stat(destPath)).size;
}

// ──────────────────────────────────────────────
//  Download npm wrapper package
// ──────────────────────────────────────────────

async function downloadWrapper(version, tmpDir) {
  const wrapperDir = join(tmpDir, 'wrapper');
  await mkdir(wrapperDir, { recursive: true });
  execFileSync('npm', ['pack', `@anthropic-ai/claude-code@${version}`, '--pack-destination', tmpDir],
    { encoding: 'utf8', timeout: 60_000 });
  execFileSync('tar', ['xzf', join(tmpDir, `anthropic-ai-claude-code-${version}.tgz`),
    '-C', wrapperDir, '--strip-components=1']);
  return wrapperDir;
}

// ──────────────────────────────────────────────
//  Download ripgrep from GitHub releases
// ──────────────────────────────────────────────

function rgPlatformMap(v) {
  return {
    'arm64-darwin': { archive: `ripgrep-${v}-aarch64-apple-darwin.tar.gz`, bin: 'rg', type: 'tar' },
    'x64-darwin':   { archive: `ripgrep-${v}-x86_64-apple-darwin.tar.gz`, bin: 'rg', type: 'tar' },
    'arm64-linux':  { archive: `ripgrep-${v}-aarch64-unknown-linux-gnu.tar.gz`, bin: 'rg', type: 'tar' },
    'x64-linux':    { archive: `ripgrep-${v}-x86_64-unknown-linux-musl.tar.gz`, bin: 'rg', type: 'tar' },
    'arm64-win32':  { archive: `ripgrep-${v}-aarch64-pc-windows-msvc.zip`, bin: 'rg.exe', type: 'zip' },
    'x64-win32':    { archive: `ripgrep-${v}-x86_64-pc-windows-msvc.zip`, bin: 'rg.exe', type: 'zip' },
  };
}

async function downloadRipgrep(tmpDir, rgVersion) {
  const ripgrepDir = join(tmpDir, 'ripgrep');
  await mkdir(ripgrepDir, { recursive: true });
  console.log(`  ripgrep v${rgVersion} from GitHub...`);
  const RG_BASE = `https://github.com/BurntSushi/ripgrep/releases/download/${rgVersion}`;
  const map = rgPlatformMap(rgVersion);
  let downloaded = 0;

  for (const [vendorDir, info] of Object.entries(map)) {
    const archivePath = join(tmpDir, info.archive);
    try {
      await downloadFile(`${RG_BASE}/${info.archive}`, archivePath);
      const destDir = join(ripgrepDir, vendorDir);
      await mkdir(destDir, { recursive: true });
      if (info.type === 'tar') {
        tarExtract(archivePath, destDir, 1, [`*/${info.bin}`]);
      } else {
        execFileSync('unzip', ['-jo', archivePath, `*/${info.bin}`, '-d', destDir], { stdio: 'pipe' });
      }
      await stat(join(destDir, info.bin));
      downloaded++;
      await rm(archivePath, { force: true });
    } catch (e) {
      console.log(`    ⚠ ${vendorDir}: ${e.message.split('\n')[0]}`);
    }
  }

  try {
    await downloadFile(`https://raw.githubusercontent.com/BurntSushi/ripgrep/${rgVersion}/COPYING`,
      join(ripgrepDir, 'COPYING'));
  } catch {}

  console.log(`  ✓ ripgrep: ${downloaded}/${Object.keys(map).length} platforms`);
  return downloaded > 0 ? ripgrepDir : null;
}

// Download ripgrep only for specific platforms
async function downloadRipgrepForPlatforms(tmpDir, rgVersion, platforms) {
  const ripgrepDir = join(tmpDir, 'ripgrep');
  await mkdir(ripgrepDir, { recursive: true });
  console.log(`  ripgrep v${rgVersion} for ${platforms.length} platform(s)...`);
  const RG_BASE = `https://github.com/BurntSushi/ripgrep/releases/download/${rgVersion}`;
  const map = rgPlatformMap(rgVersion);
  let downloaded = 0;

  // Map output platform names to ripgrep vendor dir names
  const platformToVendor = {
    'darwin-arm64': 'arm64-darwin',
    'darwin-x64': 'x64-darwin',
    'linux-arm64': 'arm64-linux',
    'linux-x64': 'x64-linux',
    'linux-arm64-musl': 'arm64-linux',
    'linux-x64-musl': 'x64-linux',
    'win32-arm64': 'arm64-win32',
    'win32-x64': 'x64-win32',
    'android-arm64': 'arm64-linux',
  };

  for (const platform of platforms) {
    const vendorDir = platformToVendor[platform];
    if (!vendorDir) continue;
    const info = map[vendorDir];
    if (!info) continue;

    const archivePath = join(tmpDir, info.archive);
    try {
      await downloadFile(`${RG_BASE}/${info.archive}`, archivePath);
      const destDir = join(ripgrepDir, vendorDir);
      await mkdir(destDir, { recursive: true });
      if (info.type === 'tar') {
        tarExtract(archivePath, destDir, 1, [`*/${info.bin}`]);
      } else {
        execFileSync('unzip', ['-jo', archivePath, `*/${info.bin}`, '-d', destDir], { stdio: 'pipe' });
      }
      await stat(join(destDir, info.bin));
      downloaded++;
      await rm(archivePath, { force: true });
    } catch (e) {
      console.log(`    ⚠ ${platform}: ${e.message.split('\n')[0]}`);
    }
  }

  try {
    await downloadFile(`https://raw.githubusercontent.com/BurntSushi/ripgrep/${rgVersion}/COPYING`,
      join(ripgrepDir, 'COPYING'));
  } catch {}

  console.log(`  ✓ ripgrep: ${downloaded}/${platforms.length} platforms`);
  return downloaded > 0 ? ripgrepDir : null;
}

// ──────────────────────────────────────────────
//  Download seccomp from sandbox-runtime
// ──────────────────────────────────────────────

async function downloadSeccomp(tmpDir) {
  const secDir = join(tmpDir, 'sandbox-runtime');
  await mkdir(secDir, { recursive: true });
  console.log('  seccomp from @anthropic-ai/sandbox-runtime...');
  execFileSync('npm', ['pack', '@anthropic-ai/sandbox-runtime', '--pack-destination', tmpDir],
    { encoding: 'utf8', timeout: 60_000 });
  const files = await readdir(tmpDir);
  const tgz = files.find(f => f.startsWith('anthropic-ai-sandbox-runtime-') && f.endsWith('.tgz'));
  if (!tgz) return null;
  tarExtract(join(tmpDir, tgz), secDir, 1, ['*/dist/vendor/seccomp/*']);
  const seccompDir = join(secDir, 'dist', 'vendor', 'seccomp');
  try { await stat(seccompDir); return seccompDir; } catch { return null; }
}

// ──────────────────────────────────────────────
//  Detect rg version from native binary
// ──────────────────────────────────────────────

async function detectRgVersion(binPath) {
  try {
    const { symlinkSync, unlinkSync, mkdtempSync } = await import('node:fs');
    const tmp = mkdtempSync(join(tmpdir(), 'rg-'));
    const rgLink = join(tmp, 'rg');
    symlinkSync(binPath, rgLink);
    const out = execFileSync(rgLink, ['--version'], { encoding: 'utf8', timeout: 5000 });
    unlinkSync(rgLink);
    return out.match(/ripgrep (\d+\.\d+\.\d+)/)?.[1] ?? null;
  } catch { return null; }
}

// ──────────────────────────────────────────────
//  Create tarball
// ──────────────────────────────────────────────

async function createTarball(srcDir, destPath) {
  const tmpWrap = join(tmpdir(), `pkg-wrap-${Date.now()}`);
  const pkgDir = join(tmpWrap, 'package');
  await mkdir(pkgDir, { recursive: true });

  // Use cp -r for reliable recursive copy
  execFileSync('cp', ['-r', srcDir, pkgDir], { stdio: 'pipe' });

  // Create tarball
  execFileSync('tar', ['czf', destPath, '-C', tmpWrap, 'package'], { stdio: 'pipe' });
  await rm(tmpWrap, { recursive: true, force: true });
}

// ──────────────────────────────────────────────
//  Verify main package locally
// ──────────────────────────────────────────────

async function verifyPackage(distDir, platform = 'linux-x64') {
  console.log(`\n[?] Verifying main package with ${platform}...`);
  const verifyDir = join(tmpdir(), `verify-${Date.now()}`);

  try {
    await mkdir(verifyDir, { recursive: true });

    // Copy main package using cp -r
    execFileSync('cp', ['-r', join(distDir, 'main'), verifyDir], { stdio: 'pipe' });

    // Copy platform-specific files
    const platformDir = join(distDir, 'packages', platform);
    if (existsSync(platformDir)) {
      const cliJs = join(platformDir, 'cli.js');
      const vendorDir = join(platformDir, 'vendor');
      if (existsSync(cliJs)) await copyFile(cliJs, join(verifyDir, 'main', 'cli.js'));
      if (existsSync(vendorDir)) {
        execFileSync('cp', ['-r', vendorDir, join(verifyDir, 'main')], { stdio: 'pipe' });
      }
    }

    // Install and test
    console.log('  Installing dependencies...');
    execFileSync('npm', ['install', '--omit=optional', '--no-audit', '--no-fund'],
      { cwd: join(verifyDir, 'main'), encoding: 'utf8', timeout: 120_000, stdio: ['pipe', 'pipe', 'pipe'] });

    console.log('  Testing --version...');
    const versionOut = execFileSync('node', ['cli.js', '--version'],
      { cwd: join(verifyDir, 'main'), encoding: 'utf8', timeout: 10_000 });
    console.log(`    ${versionOut.trim()}`);

    console.log('  Testing --help...');
    const helpOut = execFileSync('node', ['cli.js', '--help'],
      { cwd: join(verifyDir, 'main'), encoding: 'utf8', timeout: 10_000 });
    console.log(`    ${helpOut.split('\n').slice(0, 3).join('\n    ')}`);

    console.log('  ✓ Verification passed');
    return true;
  } catch (e) {
    console.error(`  ✗ Verification failed: ${e.message}`);
    return false;
  } finally {
    await rm(verifyDir, { recursive: true, force: true });
  }
}

// ──────────────────────────────────────────────
//  Main extraction function
// ──────────────────────────────────────────────

export async function localExtract({
  version,
  outputDir = './dist',
  rgVersion = DEFAULT_RG_VERSION,
  verify = true,
  createTarballs = false,
  platforms = null, // null = current platform only
}) {
  const tmpDir = join(outputDir, '.tmp');
  await mkdir(tmpDir, { recursive: true });

  // Determine which platforms to process
  const targetPlatforms = platforms || [CURRENT_PLATFORM];
  const isValidPlatform = (p) => SEA_PLATFORMS.includes(p) || OUTPUT_PLATFORMS.includes(p);
  const platformsToDownload = targetPlatforms
    .map(p => PLATFORM_ALIAS[p] || p)
    .filter(isValidPlatform);

  // ── Step 1: Manifest ──
  console.log(`\n[1] Fetching manifest for v${version}...`);
  const manifest = fetchJson(`${CDN_BASE}/${version}/manifest.json`);
  console.log(`  Build: ${manifest.buildDate}`);
  console.log(`  Platforms: ${targetPlatforms.join(', ')}`);

  // ── Step 2: Download SEA binaries ──
  console.log(`\n[2] Downloading ${platformsToDownload.length} SEA binaries...`);
  await Promise.all(platformsToDownload.map(async (platform) => {
    const info = manifest.platforms[platform];
    if (!info) { console.log(`  [skip] ${platform} (not in manifest)`); return; }
    const binDir = join(tmpDir, 'bins', platform);
    await mkdir(binDir, { recursive: true });
    const size = await downloadFile(`${CDN_BASE}/${version}/${platform}/${info.binary}`, join(binDir, info.binary));
    console.log(`  ✓ ${platform} (${(size / 1024 / 1024).toFixed(0)}MB)`);
  }));

  // ── Step 3: Extract + patch ──
  console.log(`\n[3] Extracting and patching...`);
  const extractions = {};

  for (const platform of platformsToDownload) {
    const info = manifest.platforms[platform];
    if (!info) continue;
    const binPath = join(tmpDir, 'bins', platform, info.binary);
    const extractDir = join(tmpDir, 'extract', platform);

    const result = await extractBunSEA(binPath);
    await mkdir(extractDir, { recursive: true });
    for (let idx = 0; idx < result.modules.length; idx++) {
      const mod = result.modules[idx];
      let name = mod.name;
      if (name.startsWith(result.basePath)) name = name.slice(result.basePath.length);
      if (name.startsWith('root/')) name = name.slice(5);
      if (idx === result.entryPointId) name = name.replace(/\.[^.]+$/, '') + '.' + mod.loader;
      if (mod.contents?.length > 0) {
        const outPath = join(extractDir, name);
        await mkdir(join(outPath, '..'), { recursive: true });
        await writeFile(outPath, mod.contents);
      }
    }

    // Verify Node.js compatibility before patching
    const cliSrc = join(extractDir, 'src', 'entrypoints', 'cli.js');
    const { compatible, fatal } = verifyNodeCompat(cliSrc);
    if (!compatible) {
      console.error(`  ✗ ${platform} — Node.js compat check failed (${fatal} fatal)`);
      console.error('    Anthropic may have removed dual-runtime fallbacks. Aborting.');
      process.exit(1);
    }
    console.log(`  ✓ ${platform} — Node.js compat verified`);

    // Patch cli.js
    const patchedPath = join(tmpDir, 'patched', `${platform}.js`);
    await mkdir(join(tmpDir, 'patched'), { recursive: true });
    await patchFile(join(extractDir, 'src', 'entrypoints', 'cli.js'), patchedPath);

    extractions[platform] = { extractDir, patchedPath, binPath };
    console.log(`  ✓ ${platform}`);

    // Clean up binary
    await rm(binPath, { force: true });
  }

  // Detect rg version from current platform binary (if available)
  if (extractions[CURRENT_PLATFORM]?.binPath) {
    const detected = await detectRgVersion(extractions[CURRENT_PLATFORM].binPath);
    if (detected) { rgVersion = detected; console.log(`  rg version: v${rgVersion}`); }
  }

  // ── Step 4: Download wrapper + vendor deps (only current platform's ripgrep) ──
  console.log(`\n[4] Downloading wrapper + vendor deps...`);
  const wrapperDir = await downloadWrapper(version, tmpDir);
  console.log('  ✓ wrapper');

  // Only download ripgrep for target platforms
  const ripgrepDir = await downloadRipgrepForPlatforms(tmpDir, rgVersion, targetPlatforms);
  const seccompDir = await downloadSeccomp(tmpDir);

  // ── Step 5: Build platform packages ──
  console.log(`\n[5] Building ${targetPlatforms.length} platform packages...`);
  for (const platform of targetPlatforms) {
    const source = PLATFORM_ALIAS[platform] || platform;
    const ext = extractions[source];
    if (!ext) { console.log(`  [skip] ${platform} — no extraction`); continue; }

    console.log(`  --- ${platform} ---`);
    await buildPlatformPackage({
      platform,
      version,
      patchedCliPath: ext.patchedPath,
      extractDir: ext.extractDir,
      ripgrepDir,
      seccompDir,
      outputDir: join(outputDir, 'packages', platform),
    });
  }

  // ── Step 6: Build main package ──
  console.log(`\n[6] Building main package...`);
  await buildMainPackage({ version, wrapperDir, outputDir: join(outputDir, 'main') });

  // ── Step 7: Verify (optional) ──
  if (verify) {
    const verifyPlatform = targetPlatforms.includes(CURRENT_PLATFORM)
      ? CURRENT_PLATFORM
      : targetPlatforms[0];
    const verified = await verifyPackage(outputDir, verifyPlatform);
    if (!verified) {
      console.error('\n✗ Verification failed. Check the output above.');
    }
  }

  // ── Step 8: Create tarballs (optional) ──
  if (createTarballs) {
    console.log(`\n[8] Creating tarballs...`);
    const artifactsDir = join(outputDir, 'artifacts');
    await mkdir(artifactsDir, { recursive: true });

    // Main package
    console.log('  main package...');
    await createTarball(join(outputDir, 'main'), join(artifactsDir, `cometix-claude-code-${version}.tgz`));

    // Platform packages
    for (const platform of targetPlatforms) {
      const platformDir = join(outputDir, 'packages', platform);
      if (existsSync(platformDir)) {
        console.log(`  ${platform}...`);
        await createTarball(platformDir, join(artifactsDir, `cometix-claude-code-${platform}-${version}.tgz`));
      }
    }

    console.log(`  ✓ Tarballs in ${artifactsDir}/`);
  }

  // ── Step 9: Cleanup ──
  console.log(`\n[9] Cleaning up...`);
  await rm(tmpDir, { recursive: true, force: true });

  console.log(`\n✓ Done. Output in ${outputDir}/`);
  console.log(`  main/          — @cometix/claude-code`);
  for (const p of targetPlatforms) {
    console.log(`  packages/${p}/  — @cometix/claude-code-${p}`);
  }
  if (createTarballs) {
    console.log(`  artifacts/     — npm tarballs`);
  }
}

// ──────────────────────────────────────────────
//  CLI
// ──────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith('local-extract.mjs');
if (isMain) {
  const args = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--version' && args[i+1]) flags.version = args[++i];
    else if (args[i] === '--output' && args[i+1]) flags.outputDir = args[++i];
    else if (args[i] === '--rg-version' && args[i+1]) flags.rgVersion = args[++i];
    else if (args[i] === '--latest') flags.latest = true;
    else if (args[i] === '--no-verify') flags.verify = false;
    else if (args[i] === '--tarballs') flags.createTarballs = true;
    else if (args[i] === '--platform' && args[i+1]) {
      flags.platforms = args[++i].split(',').map(p => p.trim());
    }
    else if (args[i] === '--all') flags.platforms = SEA_PLATFORMS;
  }

  if (!flags.version && !flags.latest) {
    console.error('Usage: node local-extract.mjs --version <ver> [options]');
    console.error('       node local-extract.mjs --latest [options]');
    console.error('');
    console.error('Options:');
    console.error('  --output <dir>     Output directory (default: ./dist)');
    console.error('  --platform <p>     Target platform(s), comma-separated (default: current)');
    console.error('  --all              Process all platforms');
    console.error('  --rg-version <ver> Ripgrep version (default: auto-detect)');
    console.error('  --no-verify        Skip verification');
    console.error('  --tarballs         Create npm tarballs');
    console.error('  --latest           Use latest version from npm');
    console.error('');
    console.error('Platforms: darwin-arm64, darwin-x64, linux-arm64, linux-x64,');
    console.error('           linux-arm64-musl, linux-x64-musl, win32-arm64, win32-x64');
    console.error(`Current: ${CURRENT_PLATFORM}`);
    process.exit(1);
  }

  if (flags.latest || !flags.version) {
    flags.version = execFileSync('npm', ['view', '@anthropic-ai/claude-code', 'version'],
      { encoding: 'utf8', timeout: 15_000 }).trim();
    console.log(`Latest version: ${flags.version}`);
  }

  await localExtract(flags);
}