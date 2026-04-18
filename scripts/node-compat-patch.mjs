import { readFile, writeFile } from 'node:fs/promises';
import * as acorn from 'acorn';

// ──────────────────────────────────────────────
//  AST helpers
// ──────────────────────────────────────────────

function walk(node, callback) {
  if (!node || typeof node !== 'object') return;
  if (node.type) callback(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item.type === 'string') walk(item, callback);
      }
    } else if (child && typeof child === 'object' && typeof child.type === 'string') {
      walk(child, callback);
    }
  }
}

function src(code, node) {
  return code.slice(node.start, node.end);
}

// Collect replacements then apply from end to start
function applyReplacements(code, replacements) {
  replacements.sort((a, b) => b.start - a.start);
  for (const r of replacements) {
    code = code.slice(0, r.start) + r.replacement + code.slice(r.end);
  }
  return code;
}

// ──────────────────────────────────────────────
//  Step A: Strip Bun CJS wrapper
// ──────────────────────────────────────────────

export function stripBunWrapper(code) {
  const BUN_HEADER = '// @bun @bytecode @bun-cjs';
  const CJS_OPEN = '(function(exports, require, module, __filename, __dirname) {';
  const CJS_CLOSE = '})';

  if (code.startsWith(BUN_HEADER)) {
    const nl = code.indexOf('\n');
    code = code.slice(nl + 1);
  }

  if (code.startsWith(CJS_OPEN)) {
    code = code.slice(CJS_OPEN.length);
  }

  const trimmed = code.trimEnd();
  if (trimmed.endsWith(CJS_CLOSE)) {
    code = trimmed.slice(0, -CJS_CLOSE.length);
  }

  // Extract version from code body (e.g. VERSION:"2.1.114")
  const verMatch = code.match(/VERSION:"(\d+\.\d+\.\d+)"/);
  const version = verMatch ? verMatch[1] : 'unknown';

  const header = [
    '#!/usr/bin/env node',
    ' // (c) Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance.',
    '',
    `// Version: ${version}`,
    '',
  ].join('\n');

  return header + code;
}

// ──────────────────────────────────────────────
//  Steps B/C/D: AST-based patching
//
//  Parse once, walk once, collect all replacements,
//  apply in reverse order.
// ──────────────────────────────────────────────

const BUILD_PATH_PREFIX = 'file:///home/runner/work/claude-cli-internal/claude-cli-internal/';

function isHardcodedBuildPath(node) {
  return node.type === 'Literal' &&
    typeof node.value === 'string' &&
    node.value.startsWith(BUILD_PATH_PREFIX);
}

export function astPatch(code) {
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'module' });
  } catch {
    // ESM parse may fail on CJS code; try script mode
    ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'script' });
  }

  const replacements = [];
  const stats = { p1Paths: 0, p1Requires: 0, p2: false, p3: 0 };

  walk(ast, (node) => {
    // ── P1: Hardcoded build paths ──
    // Pattern: <obj>.fileURLToPath("file:///home/runner/...")
    // AST: CallExpression { callee: MemberExpression { property: "fileURLToPath" }, arguments: [Literal] }
    if (node.type === 'CallExpression' &&
        node.callee?.type === 'MemberExpression' &&
        node.callee.property?.name === 'fileURLToPath' &&
        node.arguments?.length === 1 &&
        isHardcodedBuildPath(node.arguments[0])) {
      replacements.push({
        start: node.start,
        end: node.end,
        replacement: '__filename',
        tag: 'p1-path'
      });
      stats.p1Paths++;
      return;
    }

    // Pattern: <obj>.createRequire("file:///home/runner/...")
    // AST: CallExpression { callee: MemberExpression { property: "createRequire" }, arguments: [Literal] }
    if (node.type === 'CallExpression' &&
        node.callee?.type === 'MemberExpression' &&
        node.callee.property?.name === 'createRequire' &&
        node.arguments?.length === 1 &&
        isHardcodedBuildPath(node.arguments[0])) {
      // createRequire(path) returns a require function → replace whole call with `require`
      replacements.push({
        start: node.start,
        end: node.end,
        replacement: 'require',
        tag: 'p1-require'
      });
      stats.p1Requires++;
      return;
    }

    // ── P2: Bun.Transpiler throw ──
    // Pattern: if (typeof Bun > "u") throw Error("unreachable: Bun required")
    // AST: IfStatement {
    //   test: BinaryExpression { left: UnaryExpression(typeof, Bun), operator: ">", right: Literal("u") },
    //   consequent: ThrowStatement { argument: CallExpression(Error, [Literal("unreachable: Bun required")]) }
    // }
    if (node.type === 'IfStatement' &&
        node.test?.type === 'BinaryExpression' &&
        node.test.operator === '>' &&
        node.test.left?.type === 'UnaryExpression' &&
        node.test.left.operator === 'typeof' &&
        node.test.left.argument?.type === 'Identifier' &&
        node.test.left.argument.name === 'Bun' &&
        node.test.right?.type === 'Literal' &&
        node.test.right.value === 'u' &&
        node.consequent?.type === 'ThrowStatement' &&
        node.consequent.argument?.type === 'CallExpression') {
      const callArgs = node.consequent.argument.arguments;
      if (callArgs?.length === 1 &&
          callArgs[0].type === 'Literal' &&
          typeof callArgs[0].value === 'string' &&
          callArgs[0].value.includes('Bun required')) {
        replacements.push({
          start: node.start,
          end: node.end,
          replacement: 'if(typeof Bun>"u")return null;',
          tag: 'p2-transpiler'
        });
        stats.p2 = true;
        return;
      }
    }

    // ── P3: $bunfs require paths ──
    // Pattern: require("/$bunfs/root/xxx.node")
    // AST: CallExpression { callee: Identifier("require"), arguments: [Literal("/$bunfs/root/...")] }
    if (node.type === 'CallExpression' &&
        node.callee?.type === 'Identifier' &&
        node.callee.name === 'require' &&
        node.arguments?.length === 1 &&
        node.arguments[0].type === 'Literal' &&
        typeof node.arguments[0].value === 'string' &&
        node.arguments[0].value.startsWith('/$bunfs/root/')) {

      const modulePath = node.arguments[0].value;
      const moduleName = modulePath.replace('/$bunfs/root/', '');
      const baseName = moduleName.replace(/\.node$/, '');

      // Build vendor-path require with original as fallback
      const vendorRequire = [
        '(function(){try{',
        `var d=require("path").join(__dirname,"vendor","${baseName}",process.arch+"-"+process.platform,"${moduleName}");`,
        'return require(d)',
        `}catch{return require(${JSON.stringify(modulePath)})}`,
        '})()'
      ].join('');

      replacements.push({
        start: node.start,
        end: node.end,
        replacement: vendorRequire,
        tag: 'p3-bunfs'
      });
      stats.p3++;
      return;
    }
  });

  const patched = applyReplacements(code, replacements);
  return { code: patched, stats, replacementCount: replacements.length };
}

// ──────────────────────────────────────────────
//  Full pipeline
// ──────────────────────────────────────────────

export async function patchFile(inputPath, outputPath) {
  const raw = await readFile(inputPath, 'utf8');
  console.log(`Input:  ${inputPath} (${raw.length} bytes)`);

  // Step A: Strip wrapper (without shebang — added after AST patching)
  let code = stripBunWrapper(raw);
  console.log('[OK] Stripped Bun CJS wrapper');

  // Remove shebang before AST parse (acorn chokes on #!)
  let shebang = '';
  if (code.startsWith('#!')) {
    const nl = code.indexOf('\n');
    shebang = code.slice(0, nl + 1);
    code = code.slice(nl + 1);
  }

  // Steps B/C/D: AST-based patching
  console.log('[..] Parsing AST...');
  const result = astPatch(code);
  code = result.code;

  // Restore shebang
  code = shebang + code;

  const s = result.stats;
  console.log(`[OK] P1: Patched ${s.p1Paths} fileURLToPath + ${s.p1Requires} createRequire (hardcoded build paths)`);
  console.log(`[${s.p2 ? 'OK' : '! '}] P2: Bun.Transpiler guard ${s.p2 ? 'patched' : 'not found (may have changed)'}`);
  console.log(`[${s.p3 > 0 ? 'OK' : '! '}] P3: Patched ${s.p3} $bunfs require paths`);
  console.log(`     Total: ${result.replacementCount} AST replacements applied`);

  // Verify the patched code still parses (strip shebang for acorn)
  try {
    const verifyCode = code.startsWith('#!') ? code.slice(code.indexOf('\n') + 1) : code;
    acorn.parse(verifyCode, { ecmaVersion: 2022, sourceType: 'script' });
    console.log('[OK] Post-patch AST validation passed');
  } catch (e) {
    console.error('[X]  Post-patch AST validation FAILED:', e.message);
  }

  console.log(`Output: ${outputPath} (${code.length} bytes)`);
  await writeFile(outputPath, code);

  return { inputSize: raw.length, outputSize: code.length, stats: s };
}

// ──────────────────────────────────────────────
//  CLI
// ──────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith('node-compat-patch.mjs');
if (isMain) {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath) {
    console.error('Usage: node node-compat-patch.mjs <input-cli.js> [output-cli.js]');
    process.exit(1);
  }
  await patchFile(inputPath, outputPath ?? inputPath.replace(/\.js$/, '-patched.js'));
}
