/**
 * Bridge Agent tool I/O into the interactive PTY session.
 */
class PtyBridge {
  constructor(terminalManager) {
    this.terminals = terminalManager;
    /** preferred session for agent mirror (set by renderer) */
    this.preferredId = null;
  }

  setPreferred(id) {
    this.preferredId = id || null;
    return { ok: true, id: this.preferredId };
  }

  getPreferred() {
    if (this.preferredId && this.terminals.get?.(this.preferredId)) {
      return this.preferredId;
    }
    // fallback: first live session
    const list = this.terminals.list?.() || [];
    return list[0]?.id || null;
  }

  /**
   * Write raw text to preferred PTY (ANSI allowed).
   */
  write(text) {
    const id = this.getPreferred();
    if (!id) return { ok: false, error: "no pty session" };
    return this.terminals.write(id, String(text ?? ""));
  }

  banner(title) {
    const line = `\r\n\x1b[36m── Agent · ${title} ──\x1b[0m\r\n`;
    return this.write(line);
  }

  mirrorCommand(command, cwd) {
    this.banner("run_terminal");
    if (cwd) this.write(`\x1b[90mcwd: ${cwd}\x1b[0m\r\n`);
    return this.write(`\x1b[33m$ ${command}\x1b[0m\r\n`);
  }

  mirrorOutput(text) {
    if (!text) return { ok: true };
    // normalize newlines for terminal
    const t = String(text).replace(/\r?\n/g, "\r\n");
    return this.write(t.endsWith("\r\n") ? t : t + "\r\n");
  }

  mirrorTool(name, phase, detail = "") {
    if (phase === "start") {
      return this.write(
        `\r\n\x1b[35m→ tool ${name}\x1b[0m ${detail ? "\x1b[90m" + String(detail).slice(0, 120) + "\x1b[0m" : ""}\r\n`
      );
    }
    return this.write(
      `\x1b[35m← tool ${name}\x1b[0m ${detail ? "\x1b[90m" + String(detail).slice(0, 160) + "\x1b[0m" : ""}\r\n`
    );
  }

  /**
   * Run a command by typing into interactive PTY (no captured output).
   */
  runInPty(command) {
    const id = this.getPreferred();
    if (!id) return { ok: false, error: "no pty session" };
    const cmd = String(command || "").trim();
    if (!cmd) return { ok: false, error: "empty command" };
    this.mirrorCommand(cmd);
    return this.terminals.write(id, cmd + "\r");
  }
}

module.exports = { PtyBridge };
