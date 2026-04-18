import { mkdir, rm, writeFile, readFile, stat, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { extractBunSEA } from './bun-sea-extract.mjs';
import { patchFile } from './node-compat-patch.mjs';
import { assemblePackage } from './assemble-package.mjs';

// ──────────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────────

const CDN_BASE = 'https://downloads.claude.ai/claude-code-releases';

// Platforms that have audio-capture.node in their SEA
// (musl variants don't ship audio-capture)
const AUDIO_CAPTURE_PLATFORMS = [
  'darwin-arm64', 'darwin-x64',
  'linux-arm64',  'linux-x64',
  'win32-arm64',  'win32-x64',
];

// All 8 platform SEA binaries
const ALL_PLATFORMS = [
  'darwin-arm64', 'darwin-x64',
  'linux-arm64',  'linux-x64',
  'linux-arm64-musl', 'linux-x64-musl',
  'win32-arm64',  'win32-x64',
];

// Platform key → vendor directory name
function platformToVendorDir(platformKey) {
  // "darwin-arm64" → "arm64-darwin"
  // "linux-x64-musl" → skip (no vendor)
  const parts = platformKey.split('-');
  if (parts.length === 3) return null; // musl variants
  return `${parts[1]}-${parts[0]}`;
}

// ──────────────────────────────────────────────
//  Download helpers (curl-based, respects system proxy)
// ──────────────────────────────────────────────

function fetchJson(url) {
  const out = execFileSync('curl', ['-sL', '--fail', url], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(out);
}

async function downloadFile(url, destPath) {
  console.log(`  ↓ ${url.split('/').slice(-2).join('/')}`);
  execFileSync('curl', ['-sL', '--fail', '-o', destPath, url], {
    timeout: 600_000,
  });
  const s = await stat(destPath);
  return s.size;
}

// ──────────────────────────────────────────────
//  Download npm wrapper package
// ──────────────────────────────────────────────

async function downloadWrapper(version, tmpDir) {
  const wrapperDir = join(tmpDir, 'wrapper');
  await mkdir(wrapperDir, { recursive: true });

  execFileSync('npm', [
    'pack', `@anthropic-ai/claude-code@${version}`,
    '--pack-destination', tmpDir,
  ], { encoding: 'utf8', timeout: 60_000 });

  const tgzName = `anthropic-ai-claude-code-${version}.tgz`;
  execFileSync('tar', [
    'xzf', join(tmpDir, tgzName),
    '-C', wrapperDir,
    '--strip-components=1',
  ]);

  return wrapperDir;
}

// ──────────────────────────────────────────────
//  Download ripgrep from GitHub releases
// ──────────────────────────────────────────────

function rgPlatformMap(version) {
  const v = version;
  return {
    'arm64-darwin': { archive: `ripgrep-${v}-aarch64-apple-darwin.tar.gz`,           bin: 'rg',     type: 'tar' },
    'x64-darwin':   { archive: `ripgrep-${v}-x86_64-apple-darwin.tar.gz`,            bin: 'rg',     type: 'tar' },
    'arm64-linux':  { archive: `ripgrep-${v}-aarch64-unknown-linux-gnu.tar.gz`,      bin: 'rg',     type: 'tar' },
    'x64-linux':    { archive: `ripgrep-${v}-x86_64-unknown-linux-musl.tar.gz`,      bin: 'rg',     type: 'tar' },
    'arm64-win32':  { archive: `ripgrep-${v}-aarch64-pc-windows-msvc.zip`,           bin: 'rg.exe', type: 'zip' },
    'x64-win32':    { archive: `ripgrep-${v}-x86_64-pc-windows-msvc.zip`,            bin: 'rg.exe', type: 'zip' },
  };
}

// Detect rg version by running the SEA binary with argv0=rg
// Requires a native binary for the current platform (linux-x64 on GitHub Actions)
async function detectRgVersion(binPath) {
  try {
    const { execFileSync: exec } = await import('node:child_process');
    const { symlinkSync, unlinkSync, mkdtempSync } = await import('node:fs');
    const { join: j } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const tmp = mkdtempSync(j(tmpdir(), 'rg-detect-'));
    const rgLink = j(tmp, 'rg');
    symlinkSync(binPath, rgLink);

    const output = exec(rgLink, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
    });

    unlinkSync(rgLink);

    const match = output.match(/ripgrep (\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function downloadRipgrep(tmpDir, rgVersion) {
  const ripgrepDir = join(tmpDir, 'ripgrep');
  await mkdir(ripgrepDir, { recursive: true });

  console.log(`  ripgrep: downloading v${rgVersion} from GitHub...`);
  const RG_BASE = `https://github.com/BurntSushi/ripgrep/releases/download/${rgVersion}`;
  const RG_PLATFORM_MAP = rgPlatformMap(rgVersion);
  let downloaded = 0;

  for (const [vendorDir, info] of Object.entries(RG_PLATFORM_MAP)) {
    const url = `${RG_BASE}/${info.archive}`;
    const archivePath = join(tmpDir, info.archive);

    try {
      await downloadFile(url, archivePath);

      const destDir = join(ripgrepDir, vendorDir);
      await mkdir(destDir, { recursive: true });

      if (info.type === 'tar') {
        // Extract just the rg binary from the archive
        execFileSync('tar', [
          'xzf', archivePath,
          '-C', destDir,
          '--strip-components=1',
          '--include', `*/${info.bin}`,
        ]);
      } else {
        // zip (Windows) — use unzip
        execFileSync('unzip', [
          '-jo', archivePath,
          `*/${info.bin}`,
          '-d', destDir,
        ], { stdio: 'pipe' });
      }

      // Verify binary exists
      await stat(join(destDir, info.bin));
      downloaded++;
      await rm(archivePath, { force: true });
    } catch (e) {
      console.log(`    ⚠ ${vendorDir}: ${e.message}`);
    }
  }

  // Copy COPYING file
  try {
    const licensePath = join(tmpDir, `ripgrep-${rgVersion}-COPYING`);
    const licUrl = `https://raw.githubusercontent.com/BurntSushi/ripgrep/${rgVersion}/COPYING`;
    await downloadFile(licUrl, licensePath);
    await copyFile(licensePath, join(ripgrepDir, 'COPYING'));
  } catch {}

  console.log(`  ✓ ripgrep: ${downloaded}/${Object.keys(RG_PLATFORM_MAP).length} platforms`);
  return downloaded > 0 ? ripgrepDir : null;
}

// ──────────────────────────────────────────────
//  Download seccomp from @anthropic-ai/sandbox-runtime
//  (Apache-2.0 open source)
// ──────────────────────────────────────────────

async function downloadSeccomp(tmpDir) {
  const secDir = join(tmpDir, 'sandbox-runtime');
  await mkdir(secDir, { recursive: true });

  console.log('  seccomp: extracting from @anthropic-ai/sandbox-runtime...');

  execFileSync('npm', [
    'pack', '@anthropic-ai/sandbox-runtime',
    '--pack-destination', tmpDir,
  ], { encoding: 'utf8', timeout: 60_000 });

  // Find the tgz (version may vary)
  const { readdirSync } = await import('node:fs');
  const tgz = readdirSync(tmpDir).find(f => f.startsWith('anthropic-ai-sandbox-runtime-') && f.endsWith('.tgz'));
  if (!tgz) return null;

  execFileSync('tar', [
    'xzf', join(tmpDir, tgz),
    '-C', secDir,
    '--strip-components=1',
    '--include=*/dist/vendor/seccomp/*',
  ]);

  const seccompDir = join(secDir, 'dist', 'vendor', 'seccomp');
  try { await stat(seccompDir); return seccompDir; } catch { return null; }
}

// ──────────────────────────────────────────────
//  Main orchestrator
// ──────────────────────────────────────────────

const DEFAULT_RG_VERSION = '14.1.1';

export async function fetchAndProcess({
  version,
  outputDir = './output',
  platforms = ALL_PLATFORMS,
  rgVersion = DEFAULT_RG_VERSION,
}) {
  const tmpDir = join(outputDir, '.tmp');
  await mkdir(tmpDir, { recursive: true });

  // ── Step 1: Fetch manifest ──
  console.log(`\n[1] Fetching manifest for v${version}...`);
  const manifest = await fetchJson(`${CDN_BASE}/${version}/manifest.json`);
  console.log(`  Build: ${manifest.buildDate}`);
  console.log(`  Platforms: ${Object.keys(manifest.platforms).join(', ')}`);

  // ── Step 2: Download all platform binaries in parallel ──
  console.log(`\n[2] Downloading ${platforms.length} platform binaries (parallel)...`);
  const validPlatforms = platforms.filter(p => manifest.platforms[p]);

  // Parallel download
  await Promise.all(validPlatforms.map(async (platform) => {
    const info = manifest.platforms[platform];
    const binDir = join(tmpDir, 'bins', platform);
    await mkdir(binDir, { recursive: true });
    const binPath = join(binDir, info.binary);
    const size = await downloadFile(`${CDN_BASE}/${version}/${platform}/${info.binary}`, binPath);
    console.log(`  ✓ ${platform} (${(size / 1024 / 1024).toFixed(0)}MB)`);
  }));

  // ── Step 2b: Extract modules from each binary ──
  console.log(`\n[2b] Extracting modules...`);
  const extractions = {};
  let referenceCli = null;

  for (const platform of validPlatforms) {
    const info = manifest.platforms[platform];
    const binPath = join(tmpDir, 'bins', platform, info.binary);
    const extractDir = join(tmpDir, 'extract', platform);
    const result = await extractBunSEA(binPath);

    await mkdir(extractDir, { recursive: true });
    for (let idx = 0; idx < result.modules.length; idx++) {
      const mod = result.modules[idx];
      let name = mod.name;
      if (name.startsWith(result.basePath)) name = name.slice(result.basePath.length);
      if (name.startsWith('root/')) name = name.slice(5);
      if (idx === result.entryPointId) {
        name = name.replace(/\.[^.]+$/, '') + '.' + mod.loader;
      }
      if (mod.contents && mod.contents.length > 0) {
        const outPath = join(extractDir, name);
        await mkdir(join(outPath, '..'), { recursive: true });
        await writeFile(outPath, mod.contents);
      }
    }

    if (!referenceCli) {
      referenceCli = join(extractDir, 'src', 'entrypoints', 'cli.js');
    }

    extractions[platform] = { dir: extractDir, binPath };
    console.log(`  ✓ ${platform} — ${result.moduleCount} modules`);
  }

  // Detect rg version from the current platform's binary
  const currentPlatformKey = `${process.platform}-${process.arch}`;
  const nativeBinEntry = extractions[currentPlatformKey];
  if (nativeBinEntry?.binPath) {
    const detected = await detectRgVersion(nativeBinEntry.binPath);
    if (detected) {
      rgVersion = detected;
      console.log(`  rg version detected: v${rgVersion}`);
    }
  }

  // Clean up large binaries
  for (const entry of Object.values(extractions)) {
    if (entry.binPath) await rm(entry.binPath, { force: true });
  }

  // ── Step 3: Download npm wrapper ──
  console.log(`\n[3] Downloading npm wrapper package v${version}...`);
  const wrapperDir = await downloadWrapper(version, tmpDir);
  console.log(`  ✓ wrapper extracted`);

  // ── Step 4: Download vendor dependencies ──
  console.log(`\n[4] Downloading vendor dependencies...`);
  const ripgrepDir = await downloadRipgrep(tmpDir, rgVersion);
  const seccompDir = await downloadSeccomp(tmpDir);

  // ── Step 5: Patch cli.js ──
  console.log(`\n[5] Patching cli.js for Node.js compatibility...`);
  const patchedCliPath = join(tmpDir, 'cli-patched.js');
  await patchFile(referenceCli, patchedCliPath);

  // ── Step 6: Merge audio-capture from all platforms ──
  console.log(`\n[6] Merging audio-capture from platform extractions...`);
  const audioCaptureDir = join(tmpDir, 'merged-audio-capture');
  let audioMerged = 0;

  for (const platform of AUDIO_CAPTURE_PLATFORMS) {
    const entry = extractions[platform];
    if (!entry?.dir) continue;

    const vendorDir = platformToVendorDir(platform);
    if (!vendorDir) continue;

    const srcPath = join(entry.dir, 'audio-capture.node');
    try {
      await stat(srcPath);
      const destDir = join(audioCaptureDir, vendorDir);
      await mkdir(destDir, { recursive: true });
      await copyFile(srcPath, join(destDir, 'audio-capture.node'));
      audioMerged++;
    } catch {}
  }
  console.log(`  Merged ${audioMerged}/${AUDIO_CAPTURE_PLATFORMS.length} platform(s)`);

  // ── Step 7: Assemble final package ──
  console.log(`\n[7] Assembling final package...`);
  await assemblePackage({
    patchedCliPath,
    wrapperDir,
    outputDir,
    ripgrepDir,
    audioCaptureDir: audioMerged > 0 ? audioCaptureDir : null,
    seccompDir,
    skipBeautify: true,
  });

  // ── Step 8: Clean up tmp ──
  console.log(`\n[8] Cleaning up...`);
  await rm(tmpDir, { recursive: true, force: true });

  console.log(`\n✓ Done: ${join(outputDir, 'cc')}/`);
  return { version, outputDir: join(outputDir, 'cc') };
}

// ──────────────────────────────────────────────
//  CLI
// ──────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith('fetch-and-process.mjs');
if (isMain) {
  const args = process.argv.slice(2);
  const flags = { platforms: ALL_PLATFORMS };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--version' && args[i+1]) flags.version = args[++i];
    else if (args[i] === '--output' && args[i+1]) flags.outputDir = args[++i];
    else if (args[i] === '--platform' && args[i+1]) flags.platforms = [args[++i]];
    else if (args[i] === '--rg-version' && args[i+1]) flags.rgVersion = args[++i];
    else if (args[i] === '--latest') flags.latest = true;
  }

  if (!flags.version && !flags.latest) {
    console.error('Usage: node fetch-and-process.mjs --version <version> [--output <dir>] [--skip-deps]');
    console.error('       node fetch-and-process.mjs --latest [--output <dir>]');
    process.exit(1);
  }

  if (flags.latest || !flags.version) {
    const ver = execFileSync('npm', ['view', '@anthropic-ai/claude-code', 'version'], {
      encoding: 'utf8', timeout: 15_000,
    }).trim();
    flags.version = ver;
    console.log(`Latest version: ${ver}`);
  }

  await fetchAndProcess(flags);
}
