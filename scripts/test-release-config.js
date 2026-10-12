#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const YAML = require("yaml");
const root = path.resolve(__dirname, "..");
const releaseDir = path.join(__dirname, "release");
const preparePath = path.join(releaseDir, "prepare-runtime.js");
const read = (file) => fs.readFileSync(file, "utf8");
const json = (file) => JSON.parse(read(file));
const workflowPath = path.join(root, ".github/workflows/release-windows.yml");
const workflowText = read(workflowPath);
const document = YAML.parseDocument(workflowText, { uniqueKeys: true });
assert.deepEqual(document.errors, [], "发布工作流包含 YAML 解析错误");
const workflow = document.toJS();
const versions = json(path.join(releaseDir, "runtime-versions.json"));
const runtimePackage = json(path.join(releaseDir, "runtime-package.json"));
const prepareSource = read(preparePath);
const validateSource = read(path.join(releaseDir, "validate-release.js"));
const runtime = require(preparePath);
const build = workflow.jobs?.build;
const publisher = workflow.jobs?.["draft-release"];
let passed = 0;
let failed = 0;
let skipped = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`通过：${name}`); }
  catch (error) { failed++; console.error(`失败：${name}\n${error.stack}`); }
}
function skip(name) { skipped++; console.log(`跳过：${name}`); }
const steps = (job) => job.steps || [];
const commands = (job) => steps(job).map((step) => step.run || "").join("\n");
const action = (job, name) => {
  const matches = steps(job).filter((step) => step.uses?.startsWith(`${name}@`));
  assert.equal(matches.length, 1, `${name} 必须恰好使用一次`);
  return matches[0];
};
const watched = [workflowPath, preparePath, path.join(releaseDir, "validate-release.js"),
  path.join(releaseDir, "runtime-versions.json"), path.join(releaseDir, "runtime-package.json"),
  path.join(releaseDir, "requirements-windows.txt"), path.join(root, "package.json"),
  path.join(root, "package-lock.json"), path.join(root, "src-tauri/tauri.conf.json"),
  path.join(root, "src-tauri/Cargo.toml"), path.join(root, "src-tauri/Cargo.lock")];
const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const before = new Map(watched.map((file) => [file, digest(file)]));

// 子进程即使遇到回归，也不能联网、执行外部命令或写入真实发布目录。
function runPrepare(args, forceWindows = false) {
  const guard = `
    const fs = require('node:fs');
    const deny = () => { throw new Error('TEST_FORBIDDEN_SIDE_EFFECT'); };
    const methods = ['writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rm', 'rmdir', 'unlink',
      'rename', 'copyFile', 'cp', 'truncate', 'chmod', 'chown', 'utimes', 'link', 'symlink'];
    for (const name of methods) {
      if (typeof fs[name] === 'function') fs[name] = deny;
      if (typeof fs[name + 'Sync'] === 'function') fs[name + 'Sync'] = deny;
      if (typeof fs.promises[name] === 'function') fs.promises[name] = deny;
    }
    fs.createWriteStream = deny;
    for (const name of ['open', 'openSync']) {
      const original = fs[name];
      fs[name] = function(file, flags, ...rest) {
        if (!(flags === 'r' || flags === 'rs' || flags === 0)) deny();
        return original.call(this, file, flags, ...rest);
      };
    }
    const originalOpen = fs.promises.open;
    fs.promises.open = function(file, flags, ...rest) {
      if (!(flags === 'r' || flags === 'rs' || flags === 0)) deny();
      return originalOpen.call(this, file, flags, ...rest);
    };
    for (const name of ['node:http', 'node:https', 'node:http2', 'node:net', 'node:tls', 'node:dgram']) {
      const mod = require(name);
      for (const method of ['request', 'get', 'connect', 'createConnection', 'createSocket', 'createServer']) {
        if (typeof mod[method] === 'function') mod[method] = deny;
      }
    }
    globalThis.fetch = deny;
    const cp = require('node:child_process');
    for (const name of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) cp[name] = deny;
    ${forceWindows ? "Object.defineProperty(process, 'platform', { value: 'win32' });" : ""}
    process.argv = [process.execPath, ${JSON.stringify(preparePath)}, ...${JSON.stringify(args)}];
    require('node:module').runMain(${JSON.stringify(preparePath)});
  `;
  const env = { GITHUB_ACTIONS: "false" };
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const result = spawnSync(process.execPath, ["-e", guard], {
    cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, "子进程不能被信号终止");
  assert.doesNotMatch(result.stdout + result.stderr, /TEST_FORBIDDEN_SIDE_EFFECT/,
    "prepare-runtime 尝试了未经允许的副作用");
  return result;
}

test("YAML 解析器拒绝语法错误和重复键", () => {
  assert(YAML.parseDocument("jobs: [\n").errors.length > 0);
  assert(YAML.parseDocument("on: {}\non: {}\n", { uniqueKeys: true }).errors.length > 0);
});
test("标签发布、PR只读构建、手动发布默认关闭", () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ["pull_request", "push", "workflow_dispatch"]);
  assert.deepEqual(workflow.on.push.tags, ["v*"]);
  assert.deepEqual(Object.keys(workflow.on.push), ["tags"]);
  const input = workflow.on.workflow_dispatch.inputs.create_release;
  assert.equal(input.type, "boolean");
  assert.equal(input.default, false);
  assert.equal(input.required, true);
  assert.deepEqual(workflow.on.pull_request.branches, ["main"]);
  assert.doesNotMatch(workflowText, /^\s*pull_request_target:/m);
  assert.doesNotMatch(publisher.if, /pull_request|always\(/);
});
test("所有 action 均锁定完整 40 位提交 SHA", () => {
  let count = 0;
  for (const job of Object.values(workflow.jobs)) {
    if (job.uses) { assert.match(job.uses, /^[\w./-]+@[a-fA-F0-9]{40}$/); count++; }
    for (const step of steps(job)) {
      if (step.uses) { assert.match(step.uses, /^[\w./-]+@[a-fA-F0-9]{40}$/); count++; }
    }
  }
  assert(count >= 5);
});
test("默认只读，唯一写入者必须等待 build 成功", () => {
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert(build && publisher);
  assert.deepEqual(build.permissions || workflow.permissions, { contents: "read" });
  const writers = Object.entries(workflow.jobs).filter(([, job]) =>
    Object.values(job.permissions || workflow.permissions).some((value) => value === "write"));
  assert.deepEqual(writers.map(([name]) => name), ["draft-release"]);
  assert.deepEqual(publisher.permissions, { contents: "write" });
  assert.deepEqual(Array.isArray(publisher.needs) ? publisher.needs : [publisher.needs], ["build"]);
  assert.equal(build["continue-on-error"], undefined);
  assert.equal(publisher["continue-on-error"], undefined);
  assert.match(publisher.if, /github\.event_name\s*==\s*'push'/);
  assert.match(publisher.if, /inputs\.create_release\s*==\s*true/);
  assert.doesNotMatch(publisher.if, /always\(|failure\(|cancelled\(/);
  for (const step of steps(build)) assert.equal(step["continue-on-error"], undefined);
});
test("构建无令牌或 secrets，发布令牌仅在隔离作业中", () => {
  assert.doesNotMatch(JSON.stringify(build), /secrets\s*\.|github\s*\.\s*token|(?:GH_TOKEN|GITHUB_TOKEN|API_KEY|ACCESS_TOKEN|AUTH_TOKEN)/i);
  assert.doesNotMatch(JSON.stringify(workflow.env || {}), /token|secrets\s*\.|api_key/i);
  assert.equal(publisher.env.GH_TOKEN, "${{ github.token }}");
  assert.doesNotMatch(workflowText, /\$\{\{\s*secrets\s*\./i);
  for (const job of Object.values(workflow.jobs)) {
    for (const step of steps(job)) {
      assert.doesNotMatch(JSON.stringify(step.env || {}), /token|secrets\s*\.|api_key/i);
    }
  }
  assert.equal(action(build, "actions/checkout").with["persist-credentials"], false);
});
test("稀疏检出仅源码和核心技能，排除个人运行时与 target", () => {
  const checkout = action(build, "actions/checkout").with;
  assert.equal(checkout["sparse-checkout-cone-mode"], false);
  const patterns = checkout["sparse-checkout"].trim().split(/\r?\n/).map((line) => line.trim());
  const allowed = new Set(["/.github/", "/scripts/", "/src/", "/host/", "/renderer/", "/src-tauri/",
    "/resources/core-skills/", "/resources/core-skills-release.zip", "/resources/icon*.png", "/resources/icon.ico", "/package.json", "/package-lock.json", "/LICENSE"]);
  for (const pattern of patterns.filter((line) => !line.startsWith("!"))) {
    assert(allowed.has(pattern), `不允许检出的路径：${pattern}`);
  }
  for (const pattern of allowed) assert(patterns.includes(pattern), `缺少源码：${pattern}`);
  assert(patterns.includes("!/src-tauri/target/"));
  assert(patterns.includes("!/src-tauri/gen/"));
  assert(patterns.includes("!/renderer/vendor/"));
  assert.doesNotMatch(patterns.filter((line) => !line.startsWith("!")).join("\n"),
    /skill-runtime|bundled-skills|agent-runtime|\/resources\/runtime|\.zcode|\.agents|node_modules|\/target\//i);
  assert.doesNotMatch(commands(build), /sync-(?:all|skills|runtime)|sync-(?:bundled-skills|skill-runtime)\.js/i);
});
test("固定 Windows 2022、Node、Python 和 Rust 版本", () => {
  assert.equal(build["runs-on"], "windows-2022");
  assert.equal(action(build, "actions/setup-node").with["node-version"], "22.22.2");
  assert.equal(action(build, "actions/setup-python").with["python-version"], "3.13.12");
  assert.equal(action(build, "dtolnay/rust-toolchain").with.toolchain, versions.rust);
});
test("作业级 env 只使用该处允许的上下文", () => {
  // GitHub 只在作业级 env 暴露 github/needs/strategy/matrix/vars/secrets/inputs。
  // 使用 runner/steps/job/env 会让整个工作流判定为 Invalid workflow file，一个作业都不会启动。
  const allowed = new Set(["github", "needs", "strategy", "matrix", "vars", "secrets", "inputs"]);
  const seen = [];
  for (const [name, job] of Object.entries(workflow.jobs)) {
    for (const [key, value] of Object.entries(job.env || {})) {
      for (const expression of String(value).matchAll(/\$\{\{([^}]*)\}\}/g)) {
        for (const identifier of expression[1].matchAll(/(?<![.\w])[A-Za-z_][A-Za-z0-9_]*\s*\./g)) {
          const context = identifier[0].slice(0, -1).trim();
          seen.push(`${name}.env.${key} -> ${context}`);
          assert(allowed.has(context), `作业级 env 不允许使用 ${context} 上下文（${name}.env.${key}）`);
        }
      }
    }
  }
  assert(seen.length > 0 || Object.values(workflow.jobs).every((job) => !job.env || Object.keys(job.env).length === 0));
  const runnerTemp = commands(build);
  assert.doesNotMatch(JSON.stringify(workflow.jobs.build.env || {}), /runner\.temp/);
  assert(runnerTemp.includes("$env:RUNNER_TEMP"));
  assert(runnerTemp.includes("EMSODER_DOWNLOAD_DIR=$env:RUNNER_TEMP/emsoder-downloads"));
  assert(runnerTemp.includes("EMSODER_WHEEL_DIR=$env:RUNNER_TEMP/emsoder-wheels"));
});
test("回归门禁在无 Electron 二进制时可用", () => {
  const gate = steps(build).find((step) => step.name === "Run release regression gates");
  assert(gate, "缺少回归门禁步骤");
  assert.equal(gate.env.NODE_OPTIONS, "--require=${{ github.workspace }}/scripts/release/ci-electron-shim.js");
  // 必须是绝对路径：NODE_OPTIONS 会被子进程继承，而子进程的工作目录可能不同
  assert.doesNotMatch(gate.env.NODE_OPTIONS, /--require=\./);
  assert.match(gate.env.NODE_OPTIONS, /\$\{\{\s*github\.workspace\s*\}\}\//);
  assert(read(path.join(root, "scripts/release/ci-electron-shim.js")).includes("host/electron-shim.js"));
  assert(read(path.join(root, "scripts/release/ci-electron-shim.js")).includes("isTestEntry"));
  assert.doesNotMatch(commands(build), /ELECTRON_MIRROR|electron-builder|npm run dist\b/);
});
test("生成运行时时移除第三方 env 模板并拒绝真实 env", () => {
  assert(prepareSource.includes("example|sample|template"), "缺少 env 模板清理规则");
  assert(prepareSource.includes("Refusing to ship an env file"));
  assert(prepareSource.indexOf("strip(runtime)") < prepareSource.indexOf('"manifest.json"'));
  assert(prepareSource.indexOf("strip(runtime)") > prepareSource.indexOf('"npm", "ci"'));
});
test("核心技能归档校验后解压，PR构建不发布", () => {
  assert.match(versions.coreArchive.sha256, /^[a-f0-9]{64}$/);
  const run = commands(build);
  assert(run.includes('Core skill archive checksum mismatch'));
  assert(run.indexOf('Core skill archive checksum mismatch') < run.indexOf('Expand-Archive -Path $coreArchive'));
  assert(run.includes('Expand-Archive -Path $coreArchive -DestinationPath resources/core-skills'));
  assert.doesNotMatch(publisher.if, /pull_request/);
});
test("官方 TLS 运行时地址及精确 SHA256 固定", () => {
  assert.deepEqual(versions.node, {
    version: "22.22.2",
    url: "https://nodejs.org/dist/v22.22.2/node-v22.22.2-win-x64.zip",
    sha256: "7c93e9d92bf68c07182b471aa187e35ee6cd08ef0f24ab060dfff605fcc1c57c",
  });
  assert.deepEqual(versions.python, {
    version: "3.13.12",
    url: "https://www.python.org/ftp/python/3.13.12/python-3.13.12-embed-amd64.zip",
    sha256: "76f238f606250c87c6beac75dccd35ee99070a13490555936abb6cb64ecce3d0",
  });
  const run = commands(build);
  assert.match(run, /Invoke-WebRequest\s+-Uri\s+\$v\.\$name\.url\s+-OutFile\s+\$archive/);
  assert.match(run, /Get-FileHash\s+\$archive\s+-Algorithm\s+SHA256/);
  assert.match(run, /if\s*\(\$hash\s+-ne\s+\$v\.\$name\.sha256\)\s*\{\s*throw/);
  assert(run.indexOf("Get-FileHash") < run.indexOf("Expand-Archive"));
  assert.doesNotMatch(run, /SkipCertificateCheck|http:\/\//i);
  assert.match(prepareSource, /verifyArchive\(path\.join\(cache, "node\.zip"\), versions\.node\.sha256\)/);
  assert.match(prepareSource, /verifyArchive\(path\.join\(cache, "python\.zip"\), versions\.python\.sha256\)/);
  assert(prepareSource.indexOf('versions.python.sha256)') < prepareSource.indexOf("replaceGenerated(runtime)"));
});
test("npm ci、Cargo --locked 和离线 Python 安装", () => {
  assert.match(commands(build), /npm ci --ignore-scripts --no-audit --no-fund/);
  assert.match(commands(build), /tauri:build[^\n]*--locked/);
  assert.doesNotMatch(commands(build), /npm\s+(?:install|i|update)\b|pip[^\n]*--trusted-host/);
  assert.match(prepareSource, /\[npm, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"\]/);
  assert.match(prepareSource, /runtime-package-lock\.json/);
  for (const flag of ["--isolated", "--no-index", "--find-links", "--only-binary=:all:", "--no-compile"]) {
    assert(prepareSource.includes(JSON.stringify(flag)), `缺少 pip 参数：${flag}`);
  }
  assert.match(commands(build), /pip --isolated download --index-url https:\/\/pypi\.org\/simple --only-binary=:all:/);
});
test("requirements 每条依赖仅允许唯一精确 == 版本", () => {
  const lines = read(path.join(releaseDir, "requirements-windows.txt")).split(/\r?\n/)
    .map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  assert(lines.length > 0);
  const names = new Set();
  for (const line of lines) {
    assert.match(line, /^[A-Za-z0-9][A-Za-z0-9._-]*==\d+(?:\.\d+)+(?:[A-Za-z0-9.-]+)?$/,
      `未精确锁定的 requirements 行：${line}`);
    assert.doesNotMatch(line, /[<>~*]|===|https?:|\s/);
    const name = line.split("==")[0].toLowerCase().replace(/[-_.]+/g, "-");
    assert(!names.has(name), `重复依赖：${name}`);
    names.add(name);
  }
  for (const name of ["python-pptx", "openpyxl", "pymupdf", "numpy", "tavily-cli"]) assert(names.has(name));
});
test("所有 Windows Python wheels 的 SHA256 完整锁定", () => {
  const declared = read(path.join(releaseDir, "requirements-windows.txt")).split(/\r?\n/).filter((s) => s && !s.startsWith("#"));
  const locked = read(path.join(releaseDir, "requirements-windows.lock.txt")).split(/\r?\n/).filter((s) => s && !s.startsWith("#"));
  assert.equal(declared.length, locked.length);
  for (const line of locked) assert.match(line, /^[A-Za-z0-9._-]+==[0-9A-Za-z.+-]+ --hash=sha256:[a-f0-9]{64}$/);
  assert.deepEqual(locked.map((s) => s.split(" --hash=")[0]).sort(), declared.sort());
  assert(commands(build).includes("--require-hashes"));
  assert(prepareSource.includes('"--require-hashes"'));
});
test("runtime-package 与版本清单一致且直接依赖精确锁定", () => {
  assert.equal(runtimePackage.private, true);
  assert.deepEqual(runtimePackage.dependencies, versions.npmTools);
  for (const value of Object.values(runtimePackage.dependencies)) assert.match(value, /^\d+\.\d+\.\d+$/);
});
const runtimeLockPath = path.join(releaseDir, "runtime-package-lock.json");
if (fs.existsSync(runtimeLockPath)) {
  before.set(runtimeLockPath, digest(runtimeLockPath));
  test("已生成 runtime JSON 锁文件与 package 完全匹配", () => {
    const lock = json(runtimeLockPath);
    assert(lock.lockfileVersion >= 2);
    assert.equal(lock.name, runtimePackage.name);
    assert.equal(lock.version, runtimePackage.version);
    assert.equal(lock.packages[""].name, runtimePackage.name);
    assert.equal(lock.packages[""].version, runtimePackage.version);
    assert.deepEqual(lock.packages[""].dependencies, runtimePackage.dependencies);
    for (const [name, version] of Object.entries(runtimePackage.dependencies)) {
      assert.equal(lock.packages[`node_modules/${name}`].version, version);
    }
    for (const [name, pkg] of Object.entries(lock.packages)) {
      if (!name) continue;
      assert(!pkg.link, `发布锁文件不能使用本地链接：${name}`);
      assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
      assert.match(pkg.resolved, /^https:\/\//, `依赖必须使用 TLS：${name}`);
      assert.match(pkg.integrity, /^sha(?:256|384|512)-[A-Za-z0-9+/=]+(?:\s+sha(?:256|384|512)-[A-Za-z0-9+/=]+)*$/);
    }
  });
} else skip("runtime-package-lock.json 尚未生成；本地未验证，文件生成后重新运行");

test("versionInfo 默认标签、精确匹配和错误标签拒绝", () => {
  const version = json(path.join(root, "package.json")).version;
  assert.deepEqual(runtime.versionInfo(), { version, tag: `v${version}` });
  assert.deepEqual(runtime.versionInfo(`v${version}`), { version, tag: `v${version}` });
  for (const tag of [version, "v0.0.0-release-config-mismatch", "v*", "../outside", "v2.6.0\n"]) {
    assert.throws(() => runtime.versionInfo(tag), /Tag must be|version mismatch|Invalid application version/);
  }
});
test("prepare-runtime --check 默认与指定标签成功，错配非零退出", () => {
  const version = json(path.join(root, "package.json")).version;
  for (const args of [["--check"], ["--check", "--tag", `v${version}`]]) {
    const result = runPrepare(args);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), { version, tag: `v${version}` });
  }
  const bad = runPrepare(["--check", "--tag", "v0.0.0-release-config-mismatch"]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Tag must be/);
});
test("非 GitHub Actions 下即使 Windows 也拒绝准备运行时", () => {
  const guardAt = prepareSource.indexOf('process.env.GITHUB_ACTIONS !== "true"');
  assert(guardAt >= 0);
  assert.match(prepareSource, /process\.platform !== "win32" \|\| process\.env\.GITHUB_ACTIONS !== "true"/);
  assert(guardAt < prepareSource.indexOf("replaceGenerated(runtime)"));
  for (const windows of [false, true]) {
    const result = runPrepare([], windows);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CI-only on Windows; refusing to overwrite a user's runtime/);
  }
});
test("verifyArchive 临时文件的正确、错误和非法哈希", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "emsoder-release-config-"));
  try {
    const file = path.join(scratch, "archive.zip");
    const data = Buffer.from("离线发布哈希测试\n", "utf8");
    fs.writeFileSync(file, data);
    const hash = crypto.createHash("sha256").update(data).digest("hex");
    assert.equal(runtime.sha256(file), hash);
    assert.doesNotThrow(() => runtime.verifyArchive(file, hash));
    assert.throws(() => runtime.verifyArchive(file, "0".repeat(64)), /SHA256 mismatch/);
    for (const invalid of ["", "abc", "a".repeat(63), "g".repeat(64), hash.toUpperCase()]) {
      assert.throws(() => runtime.verifyArchive(file, invalid), /SHA256 mismatch/);
    }
    fs.writeFileSync(file, Buffer.concat([data, Buffer.from("变更")]));
    assert.throws(() => runtime.verifyArchive(file, hash), /SHA256 mismatch/);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});
test("contained 拒绝根自身与越界，允许子目录", () => {
  const base = path.join(os.tmpdir(), "emsoder-contained-base");
  for (const target of [base, path.join(base, "."), path.dirname(base),
    path.join(base, "../outside"), `${base}-sibling`, path.join(base, "child/../../outside")]) {
    assert.throws(() => runtime.contained(base, target), /outside the release output/);
  }
  assert.doesNotThrow(() => runtime.contained(base, path.join(base, "child")));
  assert.doesNotThrow(() => runtime.contained(base, path.join(base, "child/grandchild")));
});
test("发布只收集 setup 安装器并包含校验清单，不单独上传 exe", () => {
  assert.match(validateSource, /files\(target\)\.filter\(\(p\) => \/-setup\\\.exe\$\/i\.test\(p\)\)/);
  assert.match(validateSource, /installers\.length !== 1/);
  assert.match(validateSource, /validateResources\(\);/);
  for (const name of ["SHA256SUMS.txt", "build-info.json", "LICENSE"]) assert(validateSource.includes(JSON.stringify(name)));
  assert.match(validateSource, /createHash\("sha256"\)/);
  assert(validateSource.indexOf('"build-info.json"') < validateSource.indexOf('"SHA256SUMS.txt"'));
  const collect = steps(build).findIndex((step) => /validate-release\.js --collect/.test(step.run || ""));
  const smoke = steps(build).findIndex((step) => /npm run test:chat/.test(step.run || ""));
  const upload = action(build, "actions/upload-artifact");
  assert(collect > smoke && smoke >= 0);
  assert(steps(build).indexOf(upload) > collect);
  assert.equal(upload.with.path, "release-assets/*");
  assert.equal(upload.with["if-no-files-found"], "error");
  const download = action(publisher, "actions/download-artifact");
  assert.equal(download.with.path, "release-assets");
  assert.equal(upload.with.name.replace("steps.version", "needs.build"), download.with.name);
  assert.match(commands(publisher), /pathlib\.Path\("release-assets"\)\.glob\("\*"\)/);
});
test("发布端核对标签与测试提交，只创建或更新草稿", () => {
  const run = commands(publisher);
  assert.equal(publisher.env.BUILD_SHA, "${{ github.sha }}");
  assert.equal(publisher.env.RELEASE_TAG, "${{ needs.build.outputs.tag }}");
  assert.equal(publisher.env.BUILD_VERSION, "${{ needs.build.outputs.version }}");
  assert.match(run, /set -euo pipefail/);
  assert.match(run, /re\.fullmatch\(r"v\\d\+\\\.\\d\+\\\.\\d\+/);
  assert.match(run, /git\/ref\/tags\/\{tag\}/);
  assert.match(run, /while ref\["type"\] == "tag":/);
  assert.match(run, /git\/tags\/\{ref\['sha'\]\}/);
  assert.match(run, /if ref\["sha"\] != os\.environ\["BUILD_SHA"\]:\s*raise SystemExit/);
  assert.match(run, /meta\["commit"\] != ref\["sha"\] or meta\["version"\] != os\.environ\["BUILD_VERSION"\]/);
  assert.match(run, /if not json\.loads\(existing\.stdout\)\["isDraft"\]:\s*raise SystemExit/);
  const create = run.split(/\r?\n/).filter((line) => /"gh", "release", "create"/.test(line));
  assert.equal(create.length, 1);
  assert(create[0].includes('"--verify-tag"'));
  assert(create[0].includes('"--draft"'));
  assert(run.indexOf('if ref["sha"]') < run.indexOf('"gh", "release", "create"'));
  assert(run.indexOf('if not json.loads(existing.stdout)["isDraft"]') < run.indexOf('"gh", "release", "upload"'));
  assert.doesNotMatch(workflowText, /--draft(?:=|\s+)false|"draft"\s*:\s*false|gh\s+release\s+edit|"gh",\s*"release",\s*"edit"|softprops\/action-gh-release|tauri-apps\/tauri-action|\/releases(?:\s|["'])/i);
});
test("测试没有修改现有发布配置或版本文件", () => {
  for (const [file, hash] of before) assert.equal(digest(file), hash, `配置被改动：${file}`);
});
console.log(`发布配置测试：${passed} 通过，${failed} 失败，${skipped} 跳过；未联网，未准备或打包运行时。`);
if (failed) process.exitCode = 1;
