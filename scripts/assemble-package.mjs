import { readFile, writeFile, mkdir, copyFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

// Platform mapping: arch-os combinations for vendor directories
// Matches v2.1.112 vendor/ layout
const VENDOR_AUDIO_PLATFORMS = [
  'arm64-darwin', 'arm64-linux', 'arm64-win32',
  'x64-darwin',   'x64-linux',   'x64-win32',
];
const VENDOR_RIPGREP_PLATFORMS = [
  { dir: 'arm64-darwin', bin: 'rg' },
  { dir: 'arm64-linux',  bin: 'rg' },
  { dir: 'arm64-win32',  bin: 'rg.exe' },
  { dir: 'x64-darwin',   bin: 'rg' },
  { dir: 'x64-linux',    bin: 'rg' },
  { dir: 'x64-win32',    bin: 'rg.exe' },
];
const VENDOR_SECCOMP_PLATFORMS = [
  { dir: 'arm64', bin: 'apply-seccomp' },
  { dir: 'x64',   bin: 'apply-seccomp' },
];

// ──────────────────────────────────────────────
//  Build package.json (v2.1.112 compatible)
// ──────────────────────────────────────────────

function buildPackageJson(wrapperPkg) {
  return {
    name: '@cometix/claude-code',
    version: wrapperPkg.version,
    description: wrapperPkg.description ?? '',
    repository: {
      type: 'git',
      url: 'https://github.com/CometixSpace/claude-code',
    },
    bin: { claude: 'cli.js' },
    engines: { node: '>=18.0.0' },
    // No "type": "module" — Bun SEA cli.js uses CJS (require/exports)
    author: wrapperPkg.author ?? 'Anthropic <support@anthropic.com>',
    license: wrapperPkg.license ?? 'SEE LICENSE IN README.md',
    homepage: wrapperPkg.homepage ?? 'https://github.com/anthropics/claude-code',
    bugs: wrapperPkg.bugs ?? { url: 'https://github.com/anthropics/claude-code/issues' },
    scripts: {},
    dependencies: {
      ws: '^8.18.0',
      yaml: '^2.7.0',
      undici: '^7.3.0',
      bufferutil: '^4.0.9',
    },
    optionalDependencies: {
      '@img/sharp-darwin-arm64': '^0.34.2',
      '@img/sharp-darwin-x64': '^0.34.2',
      '@img/sharp-linux-arm': '^0.34.2',
      '@img/sharp-linux-arm64': '^0.34.2',
      '@img/sharp-linux-x64': '^0.34.2',
      '@img/sharp-linuxmusl-arm64': '^0.34.2',
      '@img/sharp-linuxmusl-x64': '^0.34.2',
      '@img/sharp-win32-arm64': '^0.34.2',
      '@img/sharp-win32-x64': '^0.34.2',
    },
    files: [
      'cli.js',
      'sdk-tools.d.ts',
      'vendor/ripgrep/',
      'vendor/audio-capture/',
      'vendor/seccomp/',
    ],
  };
}

// ──────────────────────────────────────────────
//  Place extracted .node into vendor/ structure
// ──────────────────────────────────────────────

async function placeVendorModule(extractDir, outputDir, moduleName, platform) {
  const srcPath = join(extractDir, `${moduleName}.node`);
  try {
    await stat(srcPath);
  } catch {
    return false; // source .node not extracted
  }

  // Map Bun SEA platform key (e.g. "darwin-arm64") to vendor layout (e.g. "arm64-darwin")
  const [os, arch] = platform.split('-');
  const vendorPlatform = `${arch}-${os}`;

  const destDir = join(outputDir, 'vendor', moduleName, vendorPlatform);
  await mkdir(destDir, { recursive: true });
  await copyFile(srcPath, join(destDir, `${moduleName}.node`));
  return true;
}

// ──────────────────────────────────────────────
//  Copy ripgrep binaries from external source
// ──────────────────────────────────────────────

async function copyRipgrep(srcDir, outputDir) {
  let copied = 0;
  for (const { dir, bin } of VENDOR_RIPGREP_PLATFORMS) {
    const srcPath = join(srcDir, dir, bin);
    try {
      await stat(srcPath);
      const destDir = join(outputDir, 'vendor', 'ripgrep', dir);
      await mkdir(destDir, { recursive: true });
      await copyFile(srcPath, join(destDir, bin));
      copied++;
    } catch { /* platform not available */ }
  }
  // Copy COPYING file if exists
  try {
    await copyFile(join(srcDir, 'COPYING'), join(outputDir, 'vendor', 'ripgrep', 'COPYING'));
  } catch {}

  if (copied > 0) {
    console.log(`[OK] vendor/ripgrep/ — copied ${copied} platform binary(ies)`);
  } else {
    console.log('[!]  vendor/ripgrep/ — no binaries found in source directory');
  }
}

// ──────────────────────────────────────────────
//  Copy audio-capture binaries (all platforms)
// ──────────────────────────────────────────────

async function copyAudioCapture(srcDir, outputDir) {
  let copied = 0;
  for (const platform of VENDOR_AUDIO_PLATFORMS) {
    const srcPath = join(srcDir, platform, 'audio-capture.node');
    try {
      await stat(srcPath);
      const destDir = join(outputDir, 'vendor', 'audio-capture', platform);
      await mkdir(destDir, { recursive: true });
      await copyFile(srcPath, join(destDir, 'audio-capture.node'));
      copied++;
    } catch {}
  }
  if (copied > 0) {
    console.log(`[OK] vendor/audio-capture/ — copied ${copied} platform binary(ies)`);
  } else {
    console.log('[!]  vendor/audio-capture/ — no binaries found in source directory');
  }
}

// ──────────────────────────────────────────────
//  Copy seccomp binaries from external source
// ──────────────────────────────────────────────

async function copySeccomp(srcDir, outputDir) {
  let copied = 0;
  for (const { dir, bin } of VENDOR_SECCOMP_PLATFORMS) {
    const srcPath = join(srcDir, dir, bin);
    try {
      await stat(srcPath);
      const destDir = join(outputDir, 'vendor', 'seccomp', dir);
      await mkdir(destDir, { recursive: true });
      await copyFile(srcPath, join(destDir, bin));
      copied++;
    } catch {}
  }
  if (copied > 0) {
    console.log(`[OK] vendor/seccomp/ — copied ${copied} platform binary(ies)`);
  } else {
    console.log('[!]  vendor/seccomp/ — no binaries found in source directory');
  }
}

// ──────────────────────────────────────────────
//  Run js-beautify on cli.js
// ──────────────────────────────────────────────

async function beautify(inputPath, outputPath) {
  console.log('[..] Running js-beautify (this may take 30-60s)...');
  try {
    execFileSync('js-beautify', [
      '-f', inputPath,
      '-o', outputPath,
      '--type', 'js',
    ], {
      timeout: 120_000,
      maxBuffer: 50 * 1024 * 1024,
    });
    const s = await stat(outputPath);
    console.log(`[OK] cli-unminify.js generated (${(s.size / 1024 / 1024).toFixed(1)} MB)`);
    return true;
  } catch (e) {
    console.error(`[!]  js-beautify failed: ${e.message}`);
    return false;
  }
}

// ──────────────────────────────────────────────
//  Assemble the full package
// ──────────────────────────────────────────────

export async function assemblePackage({
  patchedCliPath,
  extractDir,
  wrapperDir,
  outputDir,
  platform,
  ripgrepDir,
  audioCaptureDir,
  seccompDir,
  skipBeautify = false,
}) {
  const version = JSON.parse(await readFile(join(wrapperDir, 'package.json'), 'utf8')).version;
  const ccDir = join(outputDir, 'cc');
  await mkdir(ccDir, { recursive: true });

  console.log(`\nAssembling v${version} into ${ccDir}/`);
  console.log('─'.repeat(50));

  // 1. Copy patched cli.js
  await copyFile(patchedCliPath, join(ccDir, 'cli.js'));
  const cliStat = await stat(join(ccDir, 'cli.js'));
  console.log(`[OK] cli.js (${(cliStat.size / 1024 / 1024).toFixed(1)} MB)`);

  // 2. Build and write package.json
  const wrapperPkg = JSON.parse(await readFile(join(wrapperDir, 'package.json'), 'utf8'));
  const pkg = buildPackageJson(wrapperPkg);
  await writeFile(join(ccDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  console.log('[OK] package.json');

  // 3. Copy sdk-tools.d.ts, LICENSE.md, README.md from wrapper
  for (const file of ['sdk-tools.d.ts', 'LICENSE.md', 'README.md']) {
    try {
      await copyFile(join(wrapperDir, file), join(ccDir, file));
      console.log(`[OK] ${file}`);
    } catch {
      console.log(`[!]  ${file} not found in wrapper package`);
    }
  }

  // 4. Copy vendor/audio-capture/ from external source (all platforms)
  if (audioCaptureDir) {
    await copyAudioCapture(audioCaptureDir, ccDir);
  } else if (extractDir && platform) {
    // Fallback: place single-platform .node from SEA extraction
    const placed = await placeVendorModule(extractDir, ccDir, 'audio-capture', platform);
    if (placed) console.log(`[OK] vendor/audio-capture/ — single platform from SEA (${platform})`);
  }

  // 5. Copy ripgrep binaries from external source if provided
  if (ripgrepDir) {
    await copyRipgrep(ripgrepDir, ccDir);
  } else {
    console.log('[!]  vendor/ripgrep/ — not provided (--ripgrep-dir, or system rg in PATH)');
  }

  // 5b. Copy seccomp binaries if provided
  if (seccompDir) {
    await copySeccomp(seccompDir, ccDir);
  }

  // 6. Dependencies are declared in package.json (ws, yaml, undici, bufferutil)
  //    npm install handles them automatically when the package is installed by the user.
  //    No node_modules/ in the published package.

  // 7. Beautify
  if (!skipBeautify) {
    await beautify(join(ccDir, 'cli.js'), join(ccDir, 'cli-unminify.js'));
  }

  // 8. Summary
  console.log('─'.repeat(50));
  console.log(`\n${version}/cc/`);
  const entries = [];
  for (const name of ['cli.js', 'cli-unminify.js', 'package.json', 'sdk-tools.d.ts', 'LICENSE.md', 'README.md']) {
    try {
      const s = await stat(join(ccDir, name));
      const size = s.size > 1024 * 1024
        ? `${(s.size / 1024 / 1024).toFixed(1)}M`
        : s.size > 1024
          ? `${(s.size / 1024).toFixed(0)}K`
          : `${s.size}B`;
      entries.push(`├── ${name.padEnd(22)} ${size}`);
    } catch { /* skip */ }
  }
  // vendor summary
  try {
    const vendorStat = await stat(join(ccDir, 'vendor'));
    if (vendorStat.isDirectory()) {
      entries.push(`└── vendor/`);
    }
  } catch { /* no vendor */ }

  console.log(entries.join('\n'));
  console.log();

  return { version, outputDir: ccDir };
}

// ──────────────────────────────────────────────
//  CLI
// ──────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith('assemble-package.mjs');
if (isMain) {
  const args = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--patched-cli' && args[i+1]) flags.patchedCliPath = args[++i];
    else if (args[i] === '--extract-dir' && args[i+1]) flags.extractDir = args[++i];
    else if (args[i] === '--wrapper-dir' && args[i+1]) flags.wrapperDir = args[++i];
    else if (args[i] === '--output' && args[i+1]) flags.outputDir = args[++i];
    else if (args[i] === '--platform' && args[i+1]) flags.platform = args[++i];
    else if (args[i] === '--ripgrep-dir' && args[i+1]) flags.ripgrepDir = args[++i];
    else if (args[i] === '--audio-capture-dir' && args[i+1]) flags.audioCaptureDir = args[++i];
    else if (args[i] === '--seccomp-dir' && args[i+1]) flags.seccompDir = args[++i];
    else if (args[i] === '--skip-beautify') flags.skipBeautify = true;
    else if (args[i] === '--skip-deps') flags.skipDeps = true;
  }

  if (!flags.patchedCliPath || !flags.wrapperDir || !flags.outputDir) {
    console.error('Usage: node assemble-package.mjs \\');
    console.error('  --patched-cli <path>  --wrapper-dir <path>  --output <path> \\');
    console.error('  [--extract-dir <path>] [--platform <platform>] [--skip-beautify]');
    process.exit(1);
  }

  await assemblePackage(flags);
}
