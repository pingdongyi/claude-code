# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This project restores Claude Code for Node.js execution by extracting JavaScript from official Bun SEA (Single Executable Application) binaries and patching it for Node.js runtime compatibility. Starting from v2.1.113, Anthropic ships Claude Code as native Bun binaries instead of Node.js-runnable npm packages.

## Commands

```bash
npm ci                           # Install dependencies
npm run process -- --latest      # Process latest Claude Code version (full pipeline)
npm run process -- --version X.Y.Z  # Process specific version
npm run local -- --latest        # Local extraction (no GitHub Actions dependency)
npm run local -- --version X.Y.Z --tarballs  # Local extraction with tarballs
npm run extract                  # Extract from Bun SEA binary (requires args)
npm run patch                    # Patch cli.js for Node.js compat (requires args)
```

Individual script usage:
```bash
node scripts/fetch-and-process.mjs --latest
node scripts/fetch-and-process.mjs --version 2.1.116 --output ./dist
node scripts/local-extract.mjs --latest                      # Current platform only
node scripts/local-extract.mjs --latest --all                # All platforms
node scripts/local-extract.mjs --version 2.1.119 --platform linux-x64,linux-arm64
node scripts/local-extract.mjs --version 2.1.119 --tarballs  # Create npm tarballs
node scripts/local-extract.mjs --version 2.1.119 --no-verify # Skip verification
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
7. `build-main-package.mjs` — Creates main `@cometix/claude-code` package

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
- 9 output packages: 8 SEA platforms + android-arm64 (alias of linux-arm64)
- Each contains: `cli.js`, `vendor/ripgrep/`, `vendor/audio-capture/`, `vendor/seccomp/` (Linux only)
- Main package uses `install.cjs` postinstall to copy platform-specific files

## Key Constraints

- **Node.js compat verification must pass before patching** — The build aborts if dual-runtime fallbacks are missing
- **First SEA version is 2.1.113** — Earlier versions were Node.js-native and don't need this project
- **Ripgrep version is detected from binary** — Falls back to DEFAULT_RG_VERSION (14.1.1) if detection fails
- **Android reuses linux-arm64** — android-arm64 package aliases linux-arm64's cli.js

## Release Workflow

GitHub Actions workflow (`release.yml`) runs every 3 hours:
1. Detects new versions not yet in releases
2. Builds all packages in parallel matrix
3. Verifies main package works (install + `--version` + `--help`)
4. Creates GitHub release with artifacts
5. Publishes to npm with OIDC provenance