const path = require("path");

async function main() {
  let pty;
  try {
    pty = require("@homebridge/node-pty-prebuilt-multiarch");
  } catch (e) {
    console.error("require fail", e.message);
    process.exit(1);
  }

  const isWin = process.platform === "win32";
  const file = isWin
    ? path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe"
      )
    : process.env.SHELL || "/bin/bash";
  const args = isWin ? ["-NoLogo", "-NoProfile"] : ["-l"];

  console.log("spawn", file);
  const term = pty.spawn(file, args, {
    name: "xterm-color",
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env,
    useConpty: isWin,
  });

  let buf = "";
  term.onData((d) => {
    buf += d;
    process.stdout.write(d);
  });

  setTimeout(() => {
    term.write(isWin ? "echo EMSoderPTY\r" : "echo EMSoderPTY\n");
  }, 400);

  setTimeout(() => {
    const ok = buf.toLowerCase().includes("emsoderpty") || buf.length > 0;
    console.log("\n---");
    console.log(ok ? "PTY_OK" : "PTY_WEAK", "bytes=", buf.length);
    try {
      term.kill();
    } catch {}
    process.exit(ok ? 0 : 2);
  }, 2000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
