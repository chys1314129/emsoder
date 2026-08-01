const assert = require("assert");
const {
  listRemoteModels,
  testProvider,
} = require("../src/providers");
const {
  classifyProviderError,
  fetchWithTimeout,
} = require("../src/providers/httpUtil");

function makeResponse(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? {});
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return text; },
    async json() { return JSON.parse(text); },
    async arrayBuffer() { return Buffer.from(text); },
    body: { cancel() {} },
  };
}

function withMockFetch(fn) {
  const old = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return fn(String(url), opts, calls);
  };
  return {
    calls,
    restore() { global.fetch = old; },
  };
}

async function run(name, fn) {
  try {
    await fn();
    console.log("✓", name);
  } catch (err) {
    console.error("✗", name);
    console.error(err);
    process.exitCode = 1;
  }
}

(async () => {
  await run("listRemoteModels parses data[].id and dedupes", async () => {
    const mock = withMockFetch((url) => {
      assert(url.endsWith("/v1/models"), "should call /v1/models for /v1 base");
      return makeResponse(200, { data: [{ id: "a" }, { id: "b" }, { id: "a" }] });
    });
    try {
      const models = await listRemoteModels({ baseUrl: "https://x.test/v1", apiKey: "k", models: [] });
      assert.deepStrictEqual(models, ["a", "b"]);
      assert.strictEqual(mock.calls[0].opts.headers.Authorization, "Bearer k");
      assert.strictEqual(mock.calls[0].opts.headers["api-key"], "k");
    } finally {
      mock.restore();
    }
  });

  await run("listRemoteModels parses models[].name", async () => {
    const mock = withMockFetch(() => makeResponse(200, { models: [{ name: "m1" }, { model: "m2" }] }));
    try {
      const models = await listRemoteModels({ baseUrl: "https://x.test/v1", models: [] });
      assert.deepStrictEqual(models, ["m1", "m2"]);
    } finally {
      mock.restore();
    }
  });

  await run("listRemoteModels parses string arrays", async () => {
    const mock = withMockFetch(() => makeResponse(200, ["s1", "s2"]));
    try {
      const models = await listRemoteModels({ baseUrl: "https://x.test/v1", models: [] });
      assert.deepStrictEqual(models, ["s1", "s2"]);
    } finally {
      mock.restore();
    }
  });

  await run("listRemoteModels falls back from /v1/models to /models", async () => {
    const mock = withMockFetch((url) => {
      if (url.endsWith("/v1/models")) return makeResponse(404, { error: "not found" });
      return makeResponse(200, { data: [{ id: "fallback-ok" }] });
    });
    try {
      const models = await listRemoteModels({ baseUrl: "https://x.test", models: [] });
      assert.deepStrictEqual(models, ["fallback-ok"]);
      assert.strictEqual(mock.calls.length, 2);
    } finally {
      mock.restore();
    }
  });

  await run("listRemoteModels throws with fallbackModels on invalid response", async () => {
    const mock = withMockFetch(() => makeResponse(200, { data: [] }));
    try {
      let err;
      try {
        await listRemoteModels({ baseUrl: "https://x.test/v1", models: ["old"] });
      } catch (e) { err = e; }
      assert(err, "should throw");
      assert.deepStrictEqual(err.fallbackModels, ["old"]);
    } finally {
      mock.restore();
    }
  });

  await run("anthropic refresh returns configured models without fetch", async () => {
    const mock = withMockFetch(() => { throw new Error("should not fetch"); });
    try {
      const models = await listRemoteModels({ type: "anthropic", models: ["claude-x"] });
      assert.deepStrictEqual(models, ["claude-x"]);
      assert.strictEqual(mock.calls.length, 0);
    } finally {
      mock.restore();
    }
  });

  await run("testProvider returns structured failure with no model", async () => {
    const r = await testProvider({}, { baseUrl: "https://x.test/v1", models: [] });
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /未配置模型/);
  });

  await run("testProvider succeeds with mocked OpenAI chat", async () => {
    const mock = withMockFetch((url) => {
      if (url.endsWith("/models")) return makeResponse(200, { data: [{ id: "m" }] });
      if (url.endsWith("/chat/completions")) {
        return makeResponse(200, { choices: [{ message: { content: "EMSoder OK" } }] });
      }
      return makeResponse(404, {});
    });
    try {
      const r = await testProvider({}, {
        type: "openai",
        baseUrl: "https://x.test/v1",
        apiKey: "k",
        models: ["m"],
      });
      assert.strictEqual(r.ok, true);
      assert.match(r.message, /OK · m/);
    } finally {
      mock.restore();
    }
  });

  await run("classifyProviderError common provider errors", async () => {
    assert.strictEqual(classifyProviderError("HTTP 401 invalid api key").code, "auth");
    assert.strictEqual(classifyProviderError("HTTP 403 forbidden").code, "forbidden");
    assert.strictEqual(classifyProviderError("HTTP 429 rate limit").code, "rate_limit");
    assert.strictEqual(classifyProviderError("model not found").code, "model");
    assert.strictEqual(classifyProviderError("请求超时").code, "timeout");
  });

  await run("fetchWithTimeout returns response body still readable", async () => {
    const mock = withMockFetch(() => makeResponse(200, { data: [{ id: "ok" }] }));
    try {
      const res = await fetchWithTimeout("https://x.test/v1/models", {}, 1000);
      const text = await res.text();
      assert.match(text, /ok/);
    } finally {
      mock.restore();
    }
  });

  if (process.exitCode) process.exit(process.exitCode);
})();
