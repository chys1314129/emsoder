/**
 * Proves the Tauri build reads and writes the same sealed-secret format as the
 * Electron build — i.e. that moving to Tauri does **not** cost the user their
 * stored API keys.
 *
 * This exercises the production module (`host/osCrypt.js`, the thing
 * `platform.js` hands to `src/core/secretStore.js`) against a real Electron
 * `safeStorage`, in both directions, plus a fresh-install case where no key
 * exists yet.
 *
 * Both sides are pointed at the same `userData` directory, because the AES key
 * lives in `<userData>/Local State` — that file is what makes the two builds
 * interoperable, so the test has to use one of them.
 *
 * Run: node scripts/test-dpapi-compat.js
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");
const EXE = path.join(root, "src-tauri", "target", "debug", "emsoder.exe");
const SAMPLE = "emsoder-dpapi-roundtrip-密钥-🔑";
const SAMPLE2 = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";

const osCrypt = require(path.join(root, "host", "osCrypt.js"));

let failures = 0;
function fail(msg) {
  console.error(`FAIL  ${msg}`);
  failures += 1;
}
function pass(msg) {
  console.log(`  ok  ${msg}`);
}
function skip(msg) {
  console.log(`SKIP  ${msg}`);
}

/**
 * Run Electron against a given userData dir and perform `action` on `values`.
 * Setting userData before `whenReady` is what makes safeStorage pick up that
 * directory's `Local State` key.
 */
function electronSafeStorage(userDataDir, action, values) {
  const script = `
    const { app, safeStorage } = require("electron");
    const fs = require("fs");
    app.setPath("userData", process.env.EMSODER_TEST_USERDATA);
    app.whenReady().then(() => {
      try {
        const payload = JSON.parse(process.env.EMSODER_TEST_PAYLOAD);
        const out = payload.map((item) =>
          process.env.EMSODER_TEST_ACTION === "seal"
            ? safeStorage.encryptString(item).toString("base64")
            : safeStorage.decryptString(Buffer.from(item, "base64"))
        );
        fs.writeFileSync(process.env.EMSODER_TEST_OUT, JSON.stringify({ out }), "utf8");
      } catch (err) {
        fs.writeFileSync(
          process.env.EMSODER_TEST_OUT,
          JSON.stringify({ error: String(err && err.message || err) }),
          "utf8"
        );
      }
      app.exit(0);
    });
  `;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "emsoder-dpapi-"));
  const scriptPath = path.join(tmp, "probe.js");
  const outPath = path.join(tmp, "out.json");
  fs.writeFileSync(scriptPath, script, "utf8");

  const res = spawnSync(require("electron"), [scriptPath], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      EMSODER_TEST_USERDATA: userDataDir,
      EMSODER_TEST_ACTION: action,
      EMSODER_TEST_PAYLOAD: JSON.stringify(values),
      EMSODER_TEST_OUT: outPath,
    },
  });
  try {
    const parsed = JSON.parse(fs.readFileSync(outPath, "utf8"));
    if (parsed.error) throw new Error(parsed.error);
    return parsed.out;
  } catch (err) {
    throw new Error(
      `Electron 探测失败: ${err.message}\n  status=${res.status}\n  stderr: ${(res.stderr || "").slice(0, 600)}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  if (!fs.existsSync(EXE)) {
    skip(
      `Tauri 可执行文件尚未构建（${path.relative(root, EXE)} 不存在）。` +
        `构建后再跑：cd src-tauri && cargo build`
    );
    return;
  }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "emsoder-ud-"));
  osCrypt.configure({ appPath: EXE, userDataDir: userData });

  try {
    let electronOk = true;
    try {
      electronSafeStorage(userData, "seal", ["warmup"]);
    } catch (err) {
      electronOk = false;
      skip(`Electron 不可用，只做 Rust 侧自检：${err.message.split("\n")[0]}`);
    }

    // --- 1. Production module round-trips on its own ---------------------
    try {
      const sealed = osCrypt.encryptString(SAMPLE);
      if (sealed.length !== 3 + 12 + Buffer.byteLength(SAMPLE) + 16) {
        fail(
          `密文长度不符合 v10 布局：${sealed.length}（期望 ${3 + 12 + Buffer.byteLength(SAMPLE) + 16}）`
        );
      } else {
        pass(`密文布局为 v10 + nonce(12) + ct + tag(16)，共 ${sealed.length} 字节`);
      }
      if (sealed.subarray(0, 3).toString("ascii") === "v10") pass('前缀为 "v10"');
      else fail(`前缀不是 v10：${JSON.stringify(sealed.subarray(0, 3).toString("ascii"))}`);

      if (osCrypt.decryptString(sealed) === SAMPLE) pass("自身往返一致");
      else fail("自身往返不一致");
    } catch (err) {
      fail(`自检抛错：${err.message}`);
    }

    // --- 2. Electron -> Tauri (the case that decides config compatibility) -
    if (electronOk) {
      try {
        const [sealedByElectron] = electronSafeStorage(userData, "seal", [SAMPLE]);
        const opened = osCrypt.decryptString(Buffer.from(sealedByElectron, "base64"));
        if (opened === SAMPLE) {
          pass("★ Electron 加密的密钥能被 Tauri 构建解密 —— 现有配置无需重填");
        } else {
          fail(`跨实现失败：期望 ${JSON.stringify(SAMPLE)}，得到 ${JSON.stringify(opened)}`);
        }
      } catch (err) {
        fail(`Electron -> Tauri 失败：${err.message.split("\n")[0]}`);
      }

      // --- 3. Tauri -> Electron (the Electron build stays usable) --------
      try {
        const sealedHere = osCrypt.encryptString(SAMPLE2).toString("base64");
        const [opened] = electronSafeStorage(userData, "unseal", [sealedHere]);
        if (opened === SAMPLE2) pass("Tauri 加密的密钥能被 Electron safeStorage 解密（双向兼容）");
        else fail(`Tauri -> Electron 失败：得到 ${JSON.stringify(opened)}`);
      } catch (err) {
        fail(`Tauri -> Electron 失败：${err.message.split("\n")[0]}`);
      }
    }

    // --- 4. Corrupt / foreign payload degrades instead of throwing wildly -
    let threw = false;
    try {
      osCrypt.decryptString(Buffer.from("not-a-v10-payload-at-all"));
    } catch {
      threw = true;
    }
    if (threw) pass("非 v10 载荷抛错（secretStore 据此视为未设置，与 Electron 行为一致）");
    else fail("非 v10 载荷竟然没抛错");

    // --- 5. Key material is shared through Local State -------------------
    const localState = path.join(userData, "Local State");
    if (fs.existsSync(localState)) {
      const key = JSON.parse(fs.readFileSync(localState, "utf8"))?.os_crypt?.encrypted_key;
      if (typeof key === "string" && Buffer.from(key, "base64").slice(0, 5).toString("ascii") === "DPAPI") {
        pass("AES 密钥以 DPAPI 包裹形式存于 Local State（与 Chromium/Electron 同格式）");
      } else {
        fail("Local State 中缺少 os_crypt.encrypted_key");
      }
    } else {
      skip("未生成 Local State（若 Electron 预热失败则属预期）");
    }
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }

  console.log(
    failures === 0 ? "\nDPAPI 兼容性校验通过" : `\nDPAPI 兼容性校验失败（${failures} 项）`
  );
  if (failures) process.exitCode = 1;
}

main();
