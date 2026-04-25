#!/usr/bin/env node
/**
 * Local extraction script - Single package output
 *
 * Outputs a single @anthropic-ai/claude-code package ready for local install.
 * Usage:
 *   node local-extract.mjs --version 2.1.119
 *   node local-extract.mjs --latest
 *   node local-extract.mjs --version 2.1.119 --output ./dist
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

// Platform to SEA platform mapping (handle musl and android)
function getSEAPlatform() {
  if (process.platform === 'android') return `linux-${process.arch}`;

  // Detect musl on Linux
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
//  Download ripgrep for current platform
// ──────────────────────────────────────────────

function getRgInfo(rgVersion) {
  const platform = process.platform;
  const arch = process.arch;

  // Map to ripgrep archive names
  if (platform === 'darwin' && arch === 'arm64') {
    return { archive: `ripgrep-${rgVersion}-aarch64-apple-darwin.tar.gz`, bin: 'rg' };
  }
  if (platform === 'darwin' && arch === 'x64') {
    return { archive: `ripgrep-${rgVersion}-x86_64-apple-darwin.tar.gz`, bin: 'rg' };
  }
  if (platform === 'linux' && arch === 'arm64') {
    // Both glibc and musl use same GNU archive
    return { archive: `ripgrep-${rgVersion}-aarch64-unknown-linux-gnu.tar.gz`, bin: 'rg' };
  }
  if (platform === 'linux' && arch === 'x64') {
    // Use musl version for better compatibility
    return { archive: `ripgrep-${rgVersion}-x86_64-unknown-linux-musl.tar.gz`, bin: 'rg' };
  }
  if (platform === 'win32' && arch === 'arm64') {
    return { archive: `ripgrep-${rgVersion}-aarch64-pc-windows-msvc.zip`, bin: 'rg.exe', type: 'zip' };
  }
  if (platform === 'win32' && arch === 'x64') {
    return { archive: `ripgrep-${rgVersion}-x86_64-pc-windows-msvc.zip`, bin: 'rg.exe', type: 'zip' };
  }

  return null;
}

async function downloadRipgrep(tmpDir, rgVersion) {
  const info = getRgInfo(rgVersion);
  if (!info) {
    console.log('  [skip] ripgrep — unsupported platform');
    return null;
  }

  const RG_BASE = `https://github.com/BurntSushi/ripgrep/releases/download/${rgVersion}`;
  const archivePath = join(tmpDir, info.archive);

  try {
    await downloadFile(`${RG_BASE}/${info.archive}`, archivePath);

    const destDir = join(tmpDir, 'ripgrep');
    await mkdir(destDir, { recursive: true });

    if (info.type === 'zip') {
      execFileSync('unzip', ['-jo', archivePath, `*/${info.bin}`, '-d', destDir], { stdio: 'pipe' });
    } else {
      tarExtract(archivePath, destDir, 1, [`*/${info.bin}`]);
    }

    // Verify
    await stat(join(destDir, info.bin));
    await rm(archivePath, { force: true });

    // Download LICENSE
    try {
      await downloadFile(`https://raw.githubusercontent.com/BurntSushi/ripgrep/${rgVersion}/COPYING`,
        join(destDir, 'COPYING'));
    } catch {}

    console.log(`  ✓ ripgrep v${rgVersion}`);
    return destDir;
  } catch (e) {
    console.log(`  ⚠ ripgrep download failed: ${e.message.split('\n')[0]}`);
    return null;
  }
}

// ──────────────────────────────────────────────
//  Download seccomp (Linux only)
// ──────────────────────────────────────────────

async function downloadSeccomp(tmpDir) {
  if (process.platform !== 'linux') return null;

  const secDir = join(tmpDir, 'seccomp');
  await mkdir(secDir, { recursive: true });

  console.log('  seccomp from @anthropic-ai/sandbox-runtime...');
  execFileSync('npm', ['pack', '@anthropic-ai/sandbox-runtime', '--pack-destination', tmpDir],
    { encoding: 'utf8', timeout: 60_000 });

  const files = readdirSync(tmpDir);
  const tgz = files.find(f => f.startsWith('anthropic-ai-sandbox-runtime-') && f.endsWith('.tgz'));
  if (!tgz) return null;

  tarExtract(join(tmpDir, tgz), secDir, 1, ['*/dist/vendor/seccomp/*']);

  const arch = process.arch;
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
//  Main extraction function
// ──────────────────────────────────────────────

export async function localExtract({
  version,
  outputDir = './claude-code.tgz',
  verify = true,
}) {
  const tmpDir = join(outputDir, '.tmp');
  await mkdir(tmpDir, { recursive: true });

  const seaPlatform = getSEAPlatform();
  console.log(`\nTarget: ${seaPlatform} (current: ${CURRENT_PLATFORM})`);

  // ── Step 1: Download official wrapper ──
  console.log(`\n[1] Downloading official wrapper v${version}...`);
  const wrapperDir = await downloadWrapper(version, tmpDir);

  // ── Step 2: Download SEA binary ──
  console.log(`\n[2] Downloading SEA binary for ${seaPlatform}...`);
  const manifest = fetchJson(`${CDN_BASE}/${version}/manifest.json`);
  console.log(`  Build: ${manifest.buildDate}`);

  const platformInfo = manifest.platforms[seaPlatform];
  if (!platformInfo) {
    console.error(`  ✗ Platform ${seaPlatform} not in manifest`);
    process.exit(1);
  }

  const binDir = join(tmpDir, 'bin');
  await mkdir(binDir, { recursive: true });
  const binPath = join(binDir, platformInfo.binary);
  await downloadFile(`${CDN_BASE}/${version}/${seaPlatform}/${platformInfo.binary}`, binPath);
  console.log(`  ✓ ${(await stat(binPath)).size / 1024 / 1024 | 0}MB`);

  // ── Step 3: Extract and patch cli.js ──
  console.log(`\n[3] Extracting and patching...`);
  const result = await extractBunSEA(binPath);
  let cliJs = null;

  for (let idx = 0; idx < result.modules.length; idx++) {
    const mod = result.modules[idx];
    if (idx === result.entryPointId) {
      cliJs = mod.contents;
      break;
    }
  }

  if (!cliJs) {
    console.error('  ✗ cli.js not found in SEA');
    process.exit(1);
  }

  // Write for verification and patching
  const cliSrcPath = join(tmpDir, 'cli-src.js');
  await writeFile(cliSrcPath, cliJs);

  // Verify Node.js compatibility
  const { compatible, fatal } = verifyNodeCompat(cliSrcPath);
  if (!compatible) {
    console.error(`  ✗ Node.js compat check failed (${fatal} fatal)`);
    console.error('    Anthropic may have removed dual-runtime fallbacks.');
    process.exit(1);
  }
  console.log('  ✓ Node.js compat verified');

  // Patch
  const patchedCliPath = join(tmpDir, 'cli.js');
  await patchFile(cliSrcPath, patchedCliPath);
  console.log('  ✓ cli.js patched');

  // Extract audio-capture.node if present
  let audioCapture = null;
  for (const mod of result.modules) {
    if (mod.name.endsWith('audio-capture.node')) {
      audioCapture = mod.contents;
      break;
    }
  }

  // ── Step 4: Download vendor dependencies ──
  console.log(`\n[4] Downloading vendor dependencies...`);
  const ripgrepDir = await downloadRipgrep(tmpDir, DEFAULT_RG_VERSION);
  const seccompDir = await downloadSeccomp(tmpDir);

  // ── Step 5: Assemble package in staging directory ──
  console.log(`\n[5] Assembling package...`);
  const stagingDir = join(tmpDir, 'staging');
  await mkdir(stagingDir, { recursive: true });

  // Copy wrapper files (LICENSE, README, etc.)
  const wrapperFiles = await readdir(wrapperDir, { withFileTypes: true });
  for (const file of wrapperFiles) {
    if (file.name === 'package.json' || file.name === 'cli.js' || file.name === 'bin') continue;
    if (file.isFile()) {
      await copyFile(join(wrapperDir, file.name), join(stagingDir, file.name));
      console.log(`  ✓ ${file.name}`);
    }
  }

  // Copy patched cli.js
  await copyFile(patchedCliPath, join(stagingDir, 'cli.js'));
  console.log('  ✓ cli.js');

  // Setup vendor directory
  const vendorDir = join(stagingDir, 'vendor');
  await mkdir(vendorDir, { recursive: true });

  // Ripgrep
  if (ripgrepDir) {
    const rgInfo = getRgInfo(DEFAULT_RG_VERSION);
    const rgBin = rgInfo.bin;
    const rgDestDir = join(vendorDir, 'ripgrep');
    await mkdir(rgDestDir, { recursive: true });
    await copyFile(join(ripgrepDir, rgBin), join(rgDestDir, rgBin));
    if (existsSync(join(ripgrepDir, 'COPYING'))) {
      await copyFile(join(ripgrepDir, 'COPYING'), join(rgDestDir, 'COPYING'));
    }
    console.log('  ✓ vendor/ripgrep/');
  }

  // Audio capture
  if (audioCapture) {
    const audioDir = join(vendorDir, 'audio-capture');
    await mkdir(audioDir, { recursive: true });
    await writeFile(join(audioDir, 'audio-capture.node'), audioCapture);
    console.log('  ✓ vendor/audio-capture/');
  }

  // Seccomp
  if (seccompDir) {
    const arch = process.arch;
    const srcFile = join(seccompDir, arch, 'apply-seccomp');
    if (existsSync(srcFile)) {
      const secDestDir = join(vendorDir, 'seccomp');
      await mkdir(secDestDir, { recursive: true });
      await copyFile(srcFile, join(secDestDir, 'apply-seccomp'));
      console.log('  ✓ vendor/seccomp/');
    }
  }

  // Modify package.json
  const pkgPath = join(wrapperDir, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));

  // Remove platform optionalDependencies (we have everything embedded)
  pkg.optionalDependencies = {};

  // Set bin directly to cli.js
  pkg.bin = { claude: 'cli.js' };

  // Remove postinstall (no longer needed)
  delete pkg.scripts.postinstall;

  // Add vendor to files
  pkg.files = ['cli.js', 'vendor/', 'sdk-tools.d.ts'];

  await writeFile(join(stagingDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  console.log('  ✓ package.json');

  // ── Step 6: Create tarball ──
  console.log(`\n[6] Creating tarball...`);
  const tarballName = execFileSync('npm', ['pack', '--pack-destination', dirname(outputDir)],
    { cwd: stagingDir, encoding: 'utf8', timeout: 30_000 }).trim();

  const generatedTarball = join(dirname(outputDir), tarballName);

  // Rename to desired output name if needed
  const desiredName = outputDir.endsWith('.tgz') ? outputDir : `${outputDir}.tgz`;
  if (generatedTarball !== desiredName) {
    await copyFile(generatedTarball, desiredName);
    await rm(generatedTarball, { force: true });
  }
  console.log(`  ✓ ${desiredName}`);

  // ── Step 7: Cleanup ──
  console.log(`\n[7] Cleaning up...`);
  await rm(tmpDir, { recursive: true, force: true });

  const tarballPath = outputDir.endsWith('.tgz') ? outputDir : `${outputDir}.tgz`;
  console.log(`\n✓ Done. Output: ${tarballPath}`);
  console.log('\nInstall with:');
  console.log(`  npm install ${tarballPath}`);
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
    else if (args[i] === '--no-verify') flags.verify = false;
  }

  if (!flags.version && !flags.latest) {
    console.error('Usage: node local-extract.mjs --version <ver> [options]');
    console.error('       node local-extract.mjs --latest');
    console.error('');
    console.error('Options:');
    console.error('  --output <path>  Output tarball path (default: ./claude-code.tgz)');
    console.error('  --no-verify      Skip Node.js compat verification');
    console.error('  --latest         Use latest version');
    console.error('');
    console.error(`Current platform: ${CURRENT_PLATFORM}`);
    process.exit(1);
  }

  if (!flags.outputDir) flags.outputDir = './claude-code.tgz';

  if (flags.latest || !flags.version) {
    flags.version = execFileSync('npm', ['view', '@anthropic-ai/claude-code', 'version'],
      { encoding: 'utf8', timeout: 15_000 }).trim();
    console.log(`Latest version: ${flags.version}`);
  }

  await localExtract(flags);
}