#!/usr/bin/env node
/** Image-generation configuration and scoped-env smoke test. */
const assert = require("assert");
const {
  imageGenerationEnv,
  augmentProcessEnv,
} = require("../src/tools/skillRuntime");

function main() {
  const scoped = imageGenerationEnv({
    imageGenBackend: "modelscope",
    imageGenApiKey: "local-test-key",
    imageGenModel: "custom-image-model",
  });
  assert.strictEqual(scoped.IMAGE_BACKEND, "modelscope");
  assert.strictEqual(scoped.MODELSCOPE_API_KEY, "local-test-key");
  assert.strictEqual(scoped.MODELSCOPE_MODEL, "custom-image-model");

  const openai = imageGenerationEnv({
    imageGenBackend: "openai",
    imageGenApiKey: "openai-test-key",
    imageGenBaseUrl: "https://images.example.test/v1",
  });
  assert.strictEqual(openai.OPENAI_API_KEY, "openai-test-key");
  assert.strictEqual(openai.OPENAI_BASE_URL, "https://images.example.test/v1");

  const ordinary = augmentProcessEnv({ MODELSCOPE_API_KEY: "do-not-leak", PATH: "" });
  assert.strictEqual(Object.hasOwn(ordinary, "MODELSCOPE_API_KEY"), false);

  const pptOnly = augmentProcessEnv(
    { MODELSCOPE_API_KEY: "do-not-leak", PATH: "" },
    imageGenerationEnv({ imageGenBackend: "modelscope", imageGenApiKey: "scoped-only" })
  );
  assert.strictEqual(pptOnly.MODELSCOPE_API_KEY, "scoped-only");

  console.log("OK image generation config smoke test");
}
main();
