#!/usr/bin/env node
/*
 * web_search / web_fetch 联网工具回归测试。
 * 本地单元断言（无网络）+ 真实网络冒烟（环境无网络时跳过，不算失败）。
 */
const assert = require("assert");
const { webFetch, webSearch, htmlToText, decodeEntities, isHttpUrl } = require("../src/tools/web");

function assertLocal() {
  assert.strictEqual(isHttpUrl("https://example.com/x?y=1"), true, "https ok");
  assert.strictEqual(isHttpUrl("http://127.0.0.1:8080"), true, "http ok");
  assert.strictEqual(isHttpUrl("ftp://example.com"), false, "ftp blocked");
  assert.strictEqual(isHttpUrl("file:///etc/passwd"), false, "file blocked");
  assert.strictEqual(isHttpUrl("javascript:alert(1)"), false, "javascript blocked");
  assert.strictEqual(isHttpUrl(""), false, "empty blocked");

  assert.strictEqual(decodeEntities("&amp;&lt;&gt;&#39;&#x4E2D;&nbsp;"), "&<>'中 ", "entities decoded");
  const text = htmlToText(
    '<html><head><script>var x = 1 < 2;</script><style>.a{color:red}</style></head>' +
      '<body><h1>标题</h1><p>段落一 <b>加粗</b></p><br><p>段落二</p></body></html>'
  );
  assert.ok(text.includes("标题"), "keeps headings");
  assert.ok(text.includes("段落一 加粗"), "keeps paragraph text");
  assert.ok(!text.includes("var x"), "strips scripts");
  assert.ok(!text.includes("color:red"), "strips styles");
  assert.ok(text.includes("段落二"), "keeps second paragraph");
  console.log("OK web tools local assertions (URL gate / entities / html→text)");
}

async function liveSmoke() {
  let online = false;
  try {
    const r = await webFetch("https://example.com", { maxChars: 4000 });
    assert.strictEqual(r.ok, true, "example.com fetch");
    assert.ok((r.content || "").includes("Example Domain"), "page text present");
    online = true;
  } catch {
    online = false;
  }
  if (!online) {
    console.log("SKIP live network smoke (环境无网络)");
    return;
  }
  const s = await webSearch("hello world", { count: 3 });
  assert.strictEqual(s.ok, true, "web search returns results");
  assert.ok((s.content || "").includes("Web 搜索:"), "search header present");
  // 非 http(s) URL 必须被拒
  const bad = await webFetch("file:///etc/passwd", {});
  assert.strictEqual(bad.ok, false, "file URL rejected by web_fetch");
  console.log("OK live web smoke (fetch example.com + search)");
}

(async () => {
  assertLocal();
  await liveSmoke();
  console.log("OK web tools test");
})().catch((e) => { console.error(e); process.exit(1); });
