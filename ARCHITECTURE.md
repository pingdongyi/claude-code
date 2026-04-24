# 项目完整流程详解

这是一个将 Anthropic 官方的 Bun SEA 二进制文件转换为 Node.js 可运行 npm 包的项目。

---

## 1. 问题背景

从 Claude Code v2.1.113 开始，Anthropic 改变了发布策略：
- **之前**：发布标准 npm 包，JavaScript 代码可直接在 Node.js 运行
- **现在**：发布 Bun 编译的单一可执行文件（SEA），代码被打包进二进制，无法直接用 Node.js 运行

这个项目的作用是**逆向提取**这些二进制中的 JavaScript，并**修补代码**使其恢复 Node.js 兼容性。

---

## 2. 整体管道流程

```
┌─────────────────────────────────────────────────────────────────────┐
│                     完整构建流程                                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  [1] 检测新版本                                                      │
│      check-new-versions.mjs                                         │
│      ────────────────────                                           │
│      查询 npm 上 @anthropic-ai/claude-code 的所有版本                │
│      过滤出 ≥ 2.1.113 的 SEA 版本                                    │
│      排除已发布的版本                                                 │
│                          ↓                                          │
│  [2] 下载二进制                                                      │
│      fetch-and-process.mjs (主协调器)                                │
│      ────────────────────                                           │
│      从 CDN 并行下载 8 个平台的二进制                                  │
│      darwin-arm64, darwin-x64                                       │
│      linux-arm64, linux-x64                                         │
│      linux-arm64-musl, linux-x64-musl                               │
│      win32-arm64, win32-x64                                         │
│                          ↓                                          │
│  [3] 提取 JavaScript                                                 │
│      bun-sea-extract.mjs                                            │
│      ────────────────────                                           │
│      解析二进制格式 (ELF/MachO/PE)                                    │
│      找到 .bun 或 __BUN/__bun 段                                     │
│      解析 Bun 的模块结构表                                            │
│      提取所有嵌入的 JS 模块                                            │
│                          ↓                                          │
│  [4] 验证 Node.js 兼容性                                             │
│      verify-node-compat.mjs                                         │
│      ────────────────────                                           │
│      检查代码中是否存在双运行时回退模式                                  │
│      (typeof Bun 检查、require() 调用、包回退等)                       │
│      如果失败 → 构建终止                                              │
│                          ↓                                          │
│  [5] AST 修补                                                       │
│      node-compat-patch.mjs                                          │
│      ────────────────────                                           │
│      P1: 替换硬编码 CI 路径 → __filename/require                      │
│      P2: Bun.Transpiler 抛错 → return null                          │
│      P3: $bunfs 原生模块 → vendor 目录回退                            │
│                          ↓                                          │
│  [6] 构建平台包                                                      │
│      build-platform-package.mjs                                     │
│      ────────────────────                                           │
│      为每个平台创建独立 npm 包                                         │
│      包含: cli.js, vendor/ripgrep, vendor/audio-capture, etc.        │
│                          ↓                                          │
│  [7] 构建主包                                                        │
│      build-main-package.mjs                                         │
│      ────────────────────                                           │
│      创建 @cometix/claude-code 主包                                  │
│      包含: package.json, install.cjs, cli.js 占位符                  │
│                          ↓                                          │
│  [8] 发布                                                           │
│      GitHub Actions                                                 │
│      ────────────────────                                           │
│      创建 GitHub Release                                            │
│      发布到 npm (带 OIDC provenance)                                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Bun SEA 提取详解 (`bun-sea-extract.mjs`)

### Bun SEA 格式结构

```
二进制文件
├── 正常的可执行段
├── .bun / __BUN/__bun 段  ← 我们要找的
│   ├── 尺寸前缀 (4 或 8 字节)
│   ├── Bun 数据区
│   │   ├── 模块内容区
│   │   ├── 名称字符串区
│   │   ├── sourcemap 区
│   │   └── 偏移表
│   ├── 偏移结构 (32 字节)
│   │   ├── byteCount (u64)
│   │   ├── modulesPtr (offset + length)
│   │   └── entryPointId (u32)
│   └── ---- Bun! ---- 尾部标记
```

### 提取过程

**1. 识别二进制格式：**
- MachO (macOS): magic `0xFEEDFACF` → 查找 `__BUN/__bun` 段
- PE (Windows): magic `0x5A4D` (MZ) → 查找 `.bun` 段
- ELF (Linux): magic `0x7F454C46` → 查找 `.bun` 段

**2. 使用 LIEF 解析：**
```javascript
const bin = lief.parse(binaryPath);
const sec = bin.getSection('.bun');
const content = Buffer.from(sec.content);
```

**3. 解析模块结构：**
- v1 格式：52 字节/条目
- v2 格式：36 字节/条目
- 每条目包含：名称指针、内容指针、sourcemap指针、编码、loader类型、格式

**4. 提取所有模块：**
- 遍历模块表，根据指针读取内容
- 处理路径转换：`/$bunfs/root/xxx.js` → `xxx.js`

---

## 4. Node.js 兼容性验证详解 (`verify-node-compat.mjs`)

这个脚本在修补前运行，确保原始代码**仍保留双运行时支持**。

### 关键检查项

| 检查项 | 描述 | 严重性 |
|--------|------|--------|
| `bun-cjs-wrapper` | Bun CJS 模块包装器存在 | fatal |
| `typeof-bun-guards` | typeof Bun 运行时检查 ≥ 15个 | fatal |
| `require-calls` | require() 调用 ≥ 100个 | fatal |
| `ws-fallback` | ws 包回退存在 | fatal |
| `yaml-fallback` | yaml 包回退存在 | fatal |
| `bun-transpiler-guardable` | Bun.Transpiler 有 typeof 保护 | fatal |
| `strip-ansi-fallback` | Bun.stripANSI 有 typeof 保护 | fatal |
| `string-width-fallback` | Bun.stringWidth 有 typeof 保护 | fatal |
| `hash-fallback` | Bun.hash 有 typeof + crypto 回退 | fatal |

### 为什么必须验证

Anthropic 可能会在某版本完全移除 Node.js 回退代码。如果这样，修补后代码将无法运行。验证脚本作为**安全门控**，失败时立即终止构建。

---

## 5. AST 修补详解 (`node-compat-patch.mjs`)

使用 Acorn 解析器进行安全的 AST 级代码转换。

### P1: 硬编码路径替换

**问题：** Bun 编译时将文件路径硬编码为 CI 环境路径
```javascript
// 原始代码
fileURLToPath("file:///home/runner/work/claude-cli-internal/...")
createRequire("file:///home/runner/work/claude-cli-internal/...")
```

**修复：**
```javascript
// 修补后
__filename
require
```

### P2: Bun.Transpiler 保护

**问题：** 某些代码假设 Bun 存在时会抛错
```javascript
// 原始代码
if (typeof Bun > "u") throw Error("unreachable: Bun.Transpiler requires Bun runtime")
```

**修复：**
```javascript
// 修补后
if (typeof Bun > "u") return null;
```

### P3: $bunfs 原生模块回退

**问题：** Bun 运行时将原生模块放入虚拟文件系统 `/$bunfs/`
```javascript
// 原始代码
require("/$bunfs/root/audio-capture.node")
```

**修复：** 添加 vendor 目录回退
```javascript
// 修补后
(function(){
  try {
    var d = require("path").join(__dirname, "vendor", "audio-capture", process.arch + "-" + process.platform, "audio-capture.node");
    return require(d);
  } catch {
    return require("/$bunfs/root/audio-capture.node");
  }
})()
```

---

## 6. 包结构详解

### 最终发布结构

```
npm 包结构
├── @cometix/claude-code (主包)
│   ├── package.json
│   │   ├── optionalDependencies: 9个平台包
│   │   ├── dependencies: ws, yaml, undici
│   │   ├── scripts.postinstall: "node install.cjs"
│   ├── install.cjs (postinstall 脚本)
│   ├── cli.js (占位符，被 postinstall 替换)
│   └── sdk-tools.d.ts (类型定义)
│
├── @cometix/claude-code-linux-x64 (平台包)
│   ├── package.json { os: ["linux"], cpu: ["x64"] }
│   ├── cli.js (修补后的完整代码)
│   └── vendor/
│       ├── ripgrep/x64-linux/rg
│       ├── audio-capture/x64-linux/audio-capture.node
│       └── seccomp/x64/apply-seccomp
│
├── @cometix/claude-code-darwin-arm64 (平台包)
│   ├── cli.js
│   └── vendor/
│       ├── ripgrep/arm64-darwin/rg
│       └── audio-capture/arm64-darwin/audio-capture.node
│       (无 seccomp，macOS 不需要)
│
├── @cometix/claude-code-win32-x64 (平台包)
│   ├── cli.js
│   └── vendor/
│       ├── ripgrep/x64-win32/rg.exe
│       └── audio-capture/x64-win32/audio-capture.node
│
└── ... 其他 6 个平台包
```

### install.cjs 工作流程

```javascript
// 安装时执行
function main() {
  // 1. 检测当前平台
  const platformKey = getPlatformKey(); // 如 "linux-x64"

  // 2. 找到对应的平台包
  const pkgDir = require.resolve('@cometix/claude-code-linux-x64/package.json');

  // 3. 复制 cli.js 和 vendor/ 到主包目录
  copyFileSync(srcCli, destCli);
  copyDirSync(srcVendor, destVendor);
}
```

**平台检测逻辑：**
- Linux + musl 环境 → `linux-x64-musl` 或 `linux-arm64-musl`
- Android → `android-arm64`（复用 linux-arm64 的 cli.js）
- 其他 → `${platform}-${arch}`

---

## 7. 自动化发布流程 (`release.yml`)

```
GitHub Actions 工作流
├── Job: check (每3小时运行)
│   ├── npm ci
│   ├── 检测新版本 (对比已发布的 releases)
│   └── 输出版本列表
│
├── Job: build (矩阵并行)
│   ├── 对每个版本：
│   │   ├── 运行 fetch-and-process.mjs
│   │   ├── 验证生成的包 (--version, --help)
│   │   ├── 打包为 tarball
│   │   └── 上传 artifacts
│
├── Job: release
│   ├── 同步 CHANGELOG (从 Anthropic 官方仓库)
│   ├── 创建 GitHub Release
│   └── 上传所有 tarballs
│
└── Job: publish
    ├── 下载 artifacts
    ├── 使用 OIDC provenance 发布到 npm
    └── 发布主包 + 所有平台包
```

---

## 8. 为什么这个设计可行

### Anthropic 的代码策略

Anthropic 在代码中保留了**双运行时支持**：

```javascript
// Claude Code 内部代码模式
if (typeof Bun !== "undefined") {
  // Bun 原生 API
  return Bun.serve({ ... });
} else {
  // Node.js 回退
  const http = require("http");
  return http.createServer({ ... });
}
```

这种设计使得：
1. Bun 编译时能使用 Bun 特性优化
2. 代码本身仍能在 Node.js 运行（只要修补硬编码路径）

### 本项目的作用

让 Node.js 路径生效：
- 提取代码
- 移除 Bun 编译残留（路径硬编码、包装器）
- 添加原生模块加载回退

### 关键依赖来源

| 依赖 | 来源 | 用途 |
|------|------|------|
| ripgrep | BurntSushi/ripgrep GitHub releases | 代码搜索 |
| audio-capture.node | SEA 二进制内嵌 | 语音输入 |
| seccomp (apply-seccomp) | @anthropic-ai/sandbox-runtime | Linux 沙箱 |
| ws/yaml/undici | npm | Node.js 运行时依赖 |