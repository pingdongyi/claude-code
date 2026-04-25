# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This project restores Claude Code for Node.js execution by extracting JavaScript from official Bun SEA (Single Executable Application) binaries and patching it for Node.js runtime compatibility. Starting from v2.1.113, Anthropic ships Claude Code as native Bun binaries instead of Node.js-runnable npm packages.

## Commands

```bash
npm ci                           # Install dependencies
npm run process -- --latest      # Process latest (full pipeline, all platforms)
npm run process -- --version X.Y.Z  # Process specific version
npm run local -- --latest        # Local extraction (single tarball, current platform)
npm run local -- --version 2.1.119 --output ./my-package.tgz
npm run extract                  # Extract from Bun SEA binary (requires args)
npm run patch                    # Patch cli.js for Node.js compat (requires args)
```

Individual script usage:
```bash
# Full pipeline (GitHub Actions style)
node scripts/fetch-and-process.mjs --latest
node scripts/fetch-and-process.mjs --version 2.1.116 --output ./dist

# Local extraction (multi-platform)
node scripts/local-extract.mjs --latest                      # Current platform
node scripts/local-extract.mjs --latest --platform win32-x64 # Specific platform
node scripts/local-extract.mjs --latest --all                # All platforms
node scripts/local-extract.mjs --version 2.1.119 --platform linux-x64,linux-arm64
node scripts/local-extract.mjs --version 2.1.119 --no-verify

# Install the tarball
npm install ./artifacts/anthropic-ai-claude-code-2.1.119-linux-x64.tgz

# Utilities
node scripts/bun-sea-extract.mjs <binary> [outdir]
node scripts/node-compat-patch.mjs <cli.js> [output.js]
node scripts/verify-node-compat.mjs <cli.js>
```

## Architecture

**Pipeline flow:**
1. `check-new-versions.mjs` — Detects new SEA versions from npm (≥ 2.1.113)
2. `fetch-and-process.mjs` — Orchestrates the full pipeline
3. `bun-sea-extract.mjs` — Extracts JS modules from Bun SEA format
4. `verify-node-compat.mjs` — Pre-patch verification of dual-runtime fallbacks
5. `node-compat-patch.mjs` — AST-based patching for Node.js compatibility
6. `build-platform-package.mjs` — Creates per-platform optional packages
7. `build-main-package.mjs` — Creates main `@anthropic-ai/claude-code` package

**Bun SEA extraction** (`bun-sea-extract.mjs`):
- Uses `node-lief` to parse ELF/MachO/PE binaries
- Finds `.bun` or `__BUN/__bun` sections containing embedded modules
- Parses Bun's module struct (v1/v2 formats) with offset tables
- Extracts all modules including the entry point `cli.js`

**Node.js patching** (`node-compat-patch.mjs`):
- P1: Replaces hardcoded CI build paths (`file:///home/runner/...`) with `__filename`/`require`
- P2: Guards `Bun.Transpiler` throw statement with `return null` fallback
- P3: Wraps `$bunfs` native module requires with vendor directory fallbacks
- Uses Acorn AST parser for safe code transformations

**Platform packages:**
- 8 standalone packages per platform: darwin-arm64, darwin-x64, linux-arm64, linux-x64, linux-arm64-musl, linux-x64-musl, win32-arm64, win32-x64
- Each tarball contains everything: cli.js + vendor/ripgrep + vendor/audio-capture + vendor/seccomp (Linux)
- No platform optionalDependencies needed - each package is self-contained
- Package name kept as `@anthropic-ai/claude-code` (official) for local install replacement

## Key Constraints

- **Node.js compat verification must pass before patching** — The build aborts if dual-runtime fallbacks are missing
- **First SEA version is 2.1.113** — Earlier versions were Node.js-native and don't need this project
- **CJS wrapper must be preserved** — Provides `exports`, `require`, `module`, `__filename`, `__dirname` globals

## Release Workflow

GitHub Actions workflow (`release.yml`) runs every 3 hours:
1. Detects new versions from npm (SEA platforms)
2. Extracts all 8 platforms using `local-extract.mjs --all`
3. Verifies linux-x64 package works (install + `--version` + `--help`)
4. Creates GitHub release with all platform tarballs
5. Does NOT publish to npm (keep official package name for local use)