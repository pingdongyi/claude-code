#!/usr/bin/env node
/**
 * Local extraction script - Multi-platform support
 *
 * Outputs @anthropic-ai/claude-code package(s) ready for local install.
 * Usage:
 *   node local-extract.mjs --latest                      # Current platform
 *   node local-extract.mjs --latest --platform win32-x64 # Specific platform
 *   node local-extract.mjs --latest --all                # All platforms
 */

import { mkdir, rm, writeFile, stat, copyFile, readdir, readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { extractBunSEA } from './bun-sea-extract.mjs';
import { patchFile } from './node-compat-patch.mjs';
import { verifyNodeCompat } from './verify-node-compat.mjs';

// ──────────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────────

const CDN_BASE = 'https://downloads.claude.ai/claude-code-releases';
const CURRENT_PLATFORM = `${process.platform}-${process.arch}`;
const DEFAULT_RG_VERSION = '14.1.1';

const SEA_PLATFORMS = [
  'darwin-arm64', 'darwin-x64',
  'linux-arm64', 'linux-x64',
  'linux-arm64-musl', 'linux-x64-musl',
  'win32-arm64', 'win32-x64',
];

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
//  Download official npm wrapper package
// ──────────────────────────────────────────────

async function downloadWrapper(version, tmpDir) {
  const wrapperDir = join(tmpDir, 'wrapper');
  await mkdir(wrapperDir, { recursive: true });

  console.log('  Downloading official npm wrapper...');
  execFileSync('npm', ['pack', `@anthropic-ai/claude-code@${version}`, '--pack-destination', tmpDir],
    { encoding: 'utf8', timeout: 60_000 });
  execFileSync('tar', ['xzf', join(tmpDir, `anthropic-ai-claude-code-${version}.tgz`),
    '-C', wrapperDir, '--strip-components=1']);

  return wrapperDir;
}

// ──────────────────────────────────────────────
//  Ripgrep helpers (multi-platform)
// ──────────────────────────────────────────────

function getRgArchive(platform, rgVersion) {
  const [os, arch, musl] = platform.split('-');

  if (os === 'darwin' && arch === 'arm64') {
    return { archive: `ripgrep-${rgVersion}-aarch64-apple-darwin.tar.gz`, bin: 'rg' };
  }
  if (os === 'darwin' && arch === 'x64') {
    return { archive: `ripgrep-${rgVersion}-x86_64-apple-darwin.tar.gz`, bin: 'rg' };
  }
  if (os === 'linux' && arch === 'arm64') {
    return { archive: `ripgrep-${rgVersion}-aarch64-unknown-linux-gnu.tar.gz`, bin: 'rg' };
  }
  if (os === 'linux' && arch === 'x64') {
    // Use musl version for better compatibility (works on both glibc and musl)
    return { archive: `ripgrep-${rgVersion}-x86_64-unknown-linux-musl.tar.gz`, bin: 'rg' };
  }
  if (os === 'win32' && arch === 'arm64') {
    return { archive: `ripgrep-${rgVersion}-aarch64-pc-windows-msvc.zip`, bin: 'rg.exe', type: 'zip' };
  }
  if (os === 'win32' && arch === 'x64') {
    return { archive: `ripgrep-${rgVersion}-x86_64-pc-windows-msvc.zip`, bin: 'rg.exe', type: 'zip' };
  }

  return null;
}

async function downloadRipgrepForPlatform(tmpDir, platform, rgVersion) {
  const info = getRgArchive(platform, rgVersion);
  if (!info) {
    console.log(`  [skip] ripgrep — unsupported platform ${platform}`);
    return null;
  }

  const RG_BASE = `https://github.com/BurntSushi/ripgrep/releases/download/${rgVersion}`;
  const archivePath = join(tmpDir, info.archive);

  try {
    await downloadFile(`${RG_BASE}/${info.archive}`, archivePath);

    const destDir = join(tmpDir, 'ripgrep', platform);
    await mkdir(destDir, { recursive: true });

    if (info.type === 'zip') {
      // Try unzip first, fall back to python for zip extraction
      try {
        execFileSync('unzip', ['-jo', archivePath, `*/${info.bin}`, '-d', destDir], { stdio: 'pipe' });
      } catch {
        // Use python as fallback for zip extraction
        execFileSync('python3', ['-c', `
import zipfile
import os
import shutil
with zipfile.ZipFile('${archivePath}', 'r') as z:
    for name in z.namelist():
        if name.endswith('${info.bin}'):
            data = z.read(name)
            with open(os.path.join('${destDir}', '${info.bin}'), 'wb') as f:
                f.write(data)
            break
`], { stdio: 'pipe' });
      }
    } else {
      tarExtract(archivePath, destDir, 1, [`*/${info.bin}`]);
    }

    await stat(join(destDir, info.bin));
    await rm(archivePath, { force: true });

    // Download LICENSE
    try {
      await downloadFile(`https://raw.githubusercontent.com/BurntSushi/ripgrep/${rgVersion}/COPYING`,
        join(tmpDir, 'ripgrep', 'COPYING'));
    } catch {}

    console.log(`  ✓ ripgrep v${rgVersion} for ${platform}`);
    return destDir;
  } catch (e) {
    console.log(`  ⚠ ripgrep for ${platform} failed: ${e.message.split('\n')[0]}`);
    return null;
  }
}

// ──────────────────────────────────────────────
//  Download seccomp (Linux only)
// ──────────────────────────────────────────────

async function downloadSeccomp(tmpDir, platform) {
  const [os] = platform.split('-');
  if (os !== 'linux') return null;

  const secDir = join(tmpDir, 'seccomp');
  await mkdir(secDir, { recursive: true });

  console.log('  seccomp from @anthropic-ai/sandbox-runtime...');
  execFileSync('npm', ['pack', '@anthropic-ai/sandbox-runtime', '--pack-destination', tmpDir],
    { encoding: 'utf8', timeout: 60_000 });

  const files = readdirSync(tmpDir);
  const tgz = files.find(f => f.startsWith('anthropic-ai-sandbox-runtime-') && f.endsWith('.tgz'));
  if (!tgz) return null;

  tarExtract(join(tmpDir, tgz), secDir, 1, ['*/dist/vendor/seccomp/*']);

  const [, arch] = platform.split('-');
  const seccompFile = join(secDir, 'dist', 'vendor', 'seccomp', arch, 'apply-seccomp');
  try {
    await stat(seccompFile);
    console.log(`  ✓ seccomp (${arch})`);
    return join(secDir, 'dist', 'vendor', 'seccomp');
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────
//  Extract single platform
// ──────────────────────────────────────────────

async function extractPlatform({
  platform,
  version,
  tmpDir,
  wrapperDir,
  manifest,
  outputDir,
}) {
  console.log(`\n--- Processing ${platform} ---`);

  // Download SEA binary
  console.log(`[1] Downloading SEA binary...`);
  const platformInfo = manifest.platforms[platform];
  if (!platformInfo) {
    console.error(`  ✗ Platform ${platform} not in manifest`);
    return null;
  }

  const binDir = join(tmpDir, 'bins', platform);
  await mkdir(binDir, { recursive: true });
  const binPath = join(binDir, platformInfo.binary);
  await downloadFile(`${CDN_BASE}/${version}/${platform}/${platformInfo.binary}`, binPath);
  console.log(`  ✓ ${(await stat(binPath)).size / 1024 / 1024 | 0}MB`);

  // Extract and patch cli.js
  console.log(`[2] Extracting and patching...`);
  const result = await extractBunSEA(binPath);
  let cliJs = null;
  let audioCapture = null;

  for (let idx = 0; idx < result.modules.length; idx++) {
    const mod = result.modules[idx];
    if (idx === result.entryPointId) cliJs = mod.contents;
    if (mod.name.endsWith('audio-capture.node')) audioCapture = mod.contents;
  }

  if (!cliJs) {
    console.error('  ✗ cli.js not found in SEA');
    return null;
  }

  const cliSrcPath = join(tmpDir, 'cli-src', `${platform}.js`);
  await mkdir(dirname(cliSrcPath), { recursive: true });
  await writeFile(cliSrcPath, cliJs);

  // Verify Node.js compatibility
  const { compatible, fatal } = verifyNodeCompat(cliSrcPath);
  if (!compatible) {
    console.error(`  ✗ Node.js compat check failed (${fatal} fatal)`);
    return null;
  }
  console.log('  ✓ Node.js compat verified');

  // Patch
  const patchedCliPath = join(tmpDir, 'patched', `${platform}.js`);
  await mkdir(dirname(patchedCliPath), { recursive: true });
  await patchFile(cliSrcPath, patchedCliPath);
  console.log('  ✓ cli.js patched');

  // Download vendor
  console.log(`[3] Downloading vendor...`);
  const ripgrepDir = await downloadRipgrepForPlatform(tmpDir, platform, DEFAULT_RG_VERSION);
  const seccompDir = await downloadSeccomp(tmpDir, platform);

  // Assemble staging package
  console.log(`[4] Assembling package...`);
  const stagingDir = join(tmpDir, 'staging', platform);
  await mkdir(stagingDir, { recursive: true });

  // Copy wrapper files
  const wrapperFiles = await readdir(wrapperDir, { withFileTypes: true });
  for (const file of wrapperFiles) {
    if (file.name === 'package.json' || file.name === 'cli.js' || file.name === 'bin') continue;
    if (file.isFile()) {
      await copyFile(join(wrapperDir, file.name), join(stagingDir, file.name));
    }
  }

  // Copy patched cli.js
  await copyFile(patchedCliPath, join(stagingDir, 'cli.js'));

  // Setup vendor directory
  const vendorDir = join(stagingDir, 'vendor');
  await mkdir(vendorDir, { recursive: true });

  // Ripgrep
  if (ripgrepDir) {
    const info = getRgArchive(platform, DEFAULT_RG_VERSION);
    const rgBin = info.bin;
    const rgDestDir = join(vendorDir, 'ripgrep');
    await mkdir(rgDestDir, { recursive: true });
    await copyFile(join(ripgrepDir, rgBin), join(rgDestDir, rgBin));
    if (existsSync(join(tmpDir, 'ripgrep', 'COPYING'))) {
      await copyFile(join(tmpDir, 'ripgrep', 'COPYING'), join(rgDestDir, 'COPYING'));
    }
  }

  // Audio capture
  if (audioCapture) {
    const audioDir = join(vendorDir, 'audio-capture');
    await mkdir(audioDir, { recursive: true });
    await writeFile(join(audioDir, 'audio-capture.node'), audioCapture);
  }

  // Seccomp
  if (seccompDir) {
    const [, arch] = platform.split('-');
    const srcFile = join(seccompDir, arch, 'apply-seccomp');
    if (existsSync(srcFile)) {
      const secDestDir = join(vendorDir, 'seccomp');
      await mkdir(secDestDir, { recursive: true });
      await copyFile(srcFile, join(secDestDir, 'apply-seccomp'));
    }
  }

  // Modify package.json
  const pkgPath = join(wrapperDir, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));

  pkg.dependencies = {
    ws: '^8.18.0',
    yaml: '^2.7.0',
    undici: '^7.3.0',
  };

  pkg.optionalDependencies = {
    '@img/sharp-darwin-arm64': '^0.34.2',
    '@img/sharp-darwin-x64': '^0.34.2',
    '@img/sharp-linux-arm': '^0.34.2',
    '@img/sharp-linux-arm64': '^0.34.2',
    '@img/sharp-linux-x64': '^0.34.2',
    '@img/sharp-linuxmusl-arm64': '^0.34.2',
    '@img/sharp-linuxmusl-x64': '^0.34.2',
    '@img/sharp-win32-arm64': '^0.34.2',
    '@img/sharp-win32-x64': '^0.34.2',
  };

  pkg.bin = { claude: 'cli.js' };
  pkg.scripts = pkg.scripts || {};
  delete pkg.scripts.postinstall;
  delete pkg.scripts.prepare;

  // Remove "type": "module" - we use CJS wrapper which provides require/exports/__filename
  delete pkg.type;

  // Clean and add files
  pkg.files = pkg.files || [];
  pkg.files = pkg.files.filter(f => !f.startsWith('bin/') && f !== 'install.cjs' && f !== 'cli-wrapper.cjs');
  if (!pkg.files.includes('cli.js')) pkg.files.push('cli.js');

  // Add vendor subdirs
  const stagingVendor = join(stagingDir, 'vendor');
  if (existsSync(stagingVendor)) {
    const vendorDirs = readdirSync(stagingVendor, { withFileTypes: true });
    for (const d of vendorDirs) {
      if (d.isDirectory() && !pkg.files.includes(`vendor/${d.name}/`)) {
        pkg.files.push(`vendor/${d.name}/`);
      }
    }
  }

  // Sort
  pkg.dependencies = Object.fromEntries(Object.entries(pkg.dependencies).sort(([a], [b]) => a.localeCompare(b)));
  pkg.optionalDependencies = Object.fromEntries(Object.entries(pkg.optionalDependencies).sort(([a], [b]) => a.localeCompare(b)));
  pkg.files.sort();

  await writeFile(join(stagingDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

  // Create tarball
  console.log(`[5] Creating tarball...`);

  // Resolve outputDir to absolute path
  const absOutputDir = outputDir.startsWith('/') ? outputDir : join(process.cwd(), outputDir);
  await mkdir(absOutputDir, { recursive: true });

  const tarballName = execFileSync('npm', ['pack', '--pack-destination', absOutputDir],
    { cwd: stagingDir, encoding: 'utf8', timeout: 30_000 }).trim();

  const generatedTarball = join(absOutputDir, tarballName);
  const desiredTarball = join(absOutputDir, `anthropic-ai-claude-code-${version}-${platform}.tgz`);

  if (generatedTarball !== desiredTarball) {
    await copyFile(generatedTarball, desiredTarball);
    await rm(generatedTarball, { force: true });
  }

  console.log(`  ✓ ${desiredTarball}`);

  // Cleanup binary
  await rm(binPath, { force: true });

  return desiredTarball;
}

// ──────────────────────────────────────────────
//  Main extraction function
// ──────────────────────────────────────────────

export async function localExtract({
  version,
  outputDir = './artifacts',
  platforms = null, // null = current platform, array = specified platforms
}) {
  const tmpDir = join(tmpdir(), `claude-extract-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });

  // Determine platforms
  const targetPlatforms = platforms || [getCurrentSEAPlatform()];
  console.log(`\nTarget platforms: ${targetPlatforms.join(', ')}`);

  // Download wrapper
  console.log(`\n[0] Downloading official wrapper v${version}...`);
  const wrapperDir = await downloadWrapper(version, tmpDir);

  // Fetch manifest
  const manifest = fetchJson(`${CDN_BASE}/${version}/manifest.json`);
  console.log(`  Build: ${manifest.buildDate}`);

  // Process each platform
  const outputs = [];
  for (const platform of targetPlatforms) {
    const tarball = await extractPlatform({
      platform,
      version,
      tmpDir,
      wrapperDir,
      manifest,
      outputDir,
    });
    if (tarball) outputs.push(tarball);
  }

  // Cleanup
  console.log(`\n[Final] Cleaning up...`);
  await rm(tmpDir, { recursive: true, force: true });

  console.log(`\n✓ Done. Outputs:`);
  for (const t of outputs) {
    console.log(`  ${t}`);
  }
}

// Get current platform's SEA variant
function getCurrentSEAPlatform() {
  if (process.platform === 'android') return `linux-${process.arch}`;

  if (process.platform === 'linux') {
    try {
      const report = typeof process.report?.getReport === 'function'
        ? process.report.getReport() : null;
      if (report?.header?.glibcVersionRuntime === undefined) {
        return `linux-${process.arch}-musl`;
      }
    } catch {}
  }

  return CURRENT_PLATFORM;
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
    else if (args[i] === '--latest') flags.latest = true;
    else if (args[i] === '--platform' && args[i+1]) {
      flags.platforms = args[++i].split(',').map(p => p.trim());
    }
    else if (args[i] === '--all') flags.platforms = SEA_PLATFORMS;
  }

  if (!flags.version && !flags.latest) {
    console.error('Usage: node local-extract.mjs --version <ver> [options]');
    console.error('       node local-extract.mjs --latest');
    console.error('');
    console.error('Options:');
    console.error('  --output <dir>      Output directory (default: ./artifacts)');
    console.error('  --platform <p>      Target platform(s), comma-separated (default: current)');
    console.error('  --all               Process all platforms');
    console.error('  --no-verify         Skip Node.js compat verification');
    console.error('  --latest            Use latest version');
    console.error('');
    console.error('Platforms:');
    console.error(`  ${SEA_PLATFORMS.join(', ')}`);
    console.error('');
    console.error(`Current platform: ${CURRENT_PLATFORM} → ${getCurrentSEAPlatform()}`);
    process.exit(1);
  }

  if (!flags.outputDir) flags.outputDir = './artifacts';

  if (flags.latest || !flags.version) {
    flags.version = execFileSync('npm', ['view', '@anthropic-ai/claude-code', 'version'],
      { encoding: 'utf8', timeout: 15_000 }).trim();
    console.log(`Latest version: ${flags.version}`);
  }

  await localExtract(flags);
}