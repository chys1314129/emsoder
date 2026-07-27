const path = require("path");
const { NodeDebugger } = require("../src/main/debugger");

async function main() {
  const d = new NodeDebugger();
  const sample = path.join(__dirname, "test-debug-sample.js");
  let pausedCount = 0;
  let sawDone = false;
  let finished = false;

  const finish = async (code, label) => {
    if (finished) return;
    finished = true;
    console.log("\n" + label);
    try {
      await d.stop();
    } catch {
      /* ignore */
    }
    process.exit(code);
  };

  d.on("output", (p) => {
    const t = p.text || "";
    process.stdout.write(t);
    if (t.includes("done")) sawDone = true;
  });
  d.on("paused", async (p) => {
    pausedCount++;
    console.log(
      "\n[PAUSED#" + pausedCount + "]",
      p.reason,
      p.frames?.[0]?.functionName,
      p.frames?.[0]?.line
    );
    // Always resume after a short delay so breakpoints can rebind on first pause
    setTimeout(() => {
      d.continue().catch((e) => console.error("continue failed", e.message));
    }, pausedCount === 1 ? 100 : 20);
  });
  d.on("exited", () => finish(pausedCount > 0 ? 0 : 2, pausedCount > 0 ? "DEBUG_OK" : "DEBUG_WEAK"));
  d.on("stopped", () => {
    if (!finished) finish(pausedCount > 0 ? 0 : 2, pausedCount > 0 ? "DEBUG_OK" : "DEBUG_WEAK");
  });

  d.setBreakpoint(sample, 4);
  await d.launch({ program: sample, cwd: path.dirname(sample) });
  console.log("[LAUNCHED]");

  // Fallback: if process printed done, stop debugger (node --inspect may linger)
  const iv = setInterval(() => {
    if (sawDone && pausedCount > 0) {
      clearInterval(iv);
      finish(0, "DEBUG_OK");
    }
  }, 200);

  setTimeout(() => finish(pausedCount > 0 ? 0 : 3, pausedCount > 0 ? "DEBUG_OK_TIMEOUT" : "TIMEOUT"), 6000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
