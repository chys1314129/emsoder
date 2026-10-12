/* EmsoderMarkdown: pure string -> HTML markdown rendering.
   Depends on: EmsoderDom (escapeHtml). Loaded after app-state.js / dom-util.js. */
(() => {
  const escapeHtml = (s) => EmsoderDom.escapeHtml(s);

  function renderMarkdown(src) {
    const text = String(src || "");
    const parts = [];
    const re = /```([\w-]*)\n?([\s\S]*?)```/g;
    let m;
    let last = 0;
    while ((m = re.exec(text))) {
      if (m.index > last) parts.push({ type: "text", value: text.slice(last, m.index) });
      parts.push({ type: "code", value: m[2] });
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push({ type: "text", value: text.slice(last) });

    function inlineFormat(s) {
      let out = escapeHtml(s);
      out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
      out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      out = out.replace(
        /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
        (_, linkText, url) => {
          // Strip any " or ' to prevent attribute injection (e.g. href="url" onclick=...)
          const safeUrl = url.replace(/["']/g, (c) => encodeURIComponent(c));
          return `<a href="${safeUrl}" target="_blank" rel="noreferrer">${linkText}</a>`;
        }
      );
      return out;
    }

    function formatTextBlock(block) {
      const lines = block.split(/\r?\n/);
      let html = "";
      let listType = null;
      const flushList = () => {
        if (listType) {
          html += listType === "ol" ? "</ol>" : "</ul>";
          listType = null;
        }
      };
      for (const line of lines) {
        const ul = line.match(/^\s*[-*]\s+(.+)$/);
        const ol = line.match(/^\s*\d+\.\s+(.+)$/);
        if (ul) {
          if (listType !== "ul") {
            flushList();
            listType = "ul";
            html += "<ul>";
          }
          html += `<li>${inlineFormat(ul[1])}</li>`;
          continue;
        }
        if (ol) {
          if (listType !== "ol") {
            flushList();
            listType = "ol";
            html += "<ol>";
          }
          html += `<li>${inlineFormat(ol[1])}</li>`;
          continue;
        }
        flushList();
        if (line.trim()) html += `<p>${inlineFormat(line)}</p>`;
      }
      flushList();
      return html;
    }

    return parts
      .map((p) =>
        p.type === "code"
          ? `<pre><code>${escapeHtml(p.value.replace(/\n$/, ""))}</code></pre>`
          : formatTextBlock(p.value)
      )
      .join("");
  }

  function setMsgBody(el, text, asMarkdown) {
    if (!el) return;
    if (asMarkdown) el.innerHTML = renderMarkdown(text);
    else el.textContent = text;
  }

  window.EmsoderMarkdown = { renderMarkdown, setMsgBody };
})();
