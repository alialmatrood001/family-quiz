import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createServerApiClient, ServerApiError } from "../../../src/server-api-core.js";
import { invokeApi } from "../helpers/local-vercel-api.mjs";

const root = path.resolve(import.meta.dirname, "../../..");

function response(status, body, { invalidJson = false } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (invalidJson) throw new SyntaxError("invalid JSON");
      return body;
    },
  };
}

function clientWith({ fetchImpl, tokens = ["valid-token"], currentUser = true, defaultTimeoutMs } = {}) {
  const calls = [];
  const auth = {
    currentUser: currentUser
      ? {
          async getIdToken(forceRefresh) {
            calls.push(forceRefresh);
            const token = tokens[calls.length - 1];
            if (token instanceof Error) throw token;
            return token;
          },
        }
      : null,
  };
  return {
    calls,
    client: createServerApiClient({
      transport: "vercel",
      auth,
      defaultTimeoutMs,
      fetchImpl,
    }),
  };
}

test("token lifecycle permits one refresh only and never logs token material", async () => {
  const secret = "operation10-secret-token-value";
  const seen = [];
  const originalError = console.error;
  const originalLog = console.log;
  const logs = [];
  console.error = (...values) => logs.push(values.join(" "));
  console.log = (...values) => logs.push(values.join(" "));
  try {
    const { client, calls } = clientWith({
      tokens: [secret, `${secret}-refreshed`],
      fetchImpl: async (_url, options) => {
        seen.push(options.headers.Authorization);
        return response(401, {
          ok: false,
          error: { code: "unauthenticated", message: "Authentication is required" },
        });
      },
    });
    await assert.rejects(client.recoverPlayer({ roomId: "room" }), (error) => {
      return error instanceof ServerApiError && error.code === "unauthenticated";
    });
    assert.deepEqual(calls, [false, true]);
    assert.equal(seen.length, 2);
    assert.doesNotMatch(logs.join("\n"), new RegExp(secret));
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
});

test("valid token succeeds and refresh failure is normalized without a request loop", async () => {
  const successful = clientWith({
    fetchImpl: async () => response(200, { ok: true, data: { status: "recovered" } }),
  });
  assert.equal((await successful.client.recoverPlayer({ roomId: "room" })).status, "recovered");
  assert.deepEqual(successful.calls, [false]);

  let requests = 0;
  const failedRefresh = clientWith({
    tokens: ["expired", new Error("session ended")],
    fetchImpl: async () => {
      requests += 1;
      return response(401, {
        ok: false,
        error: { code: "unauthenticated", message: "Authentication is required" },
      });
    },
  });
  await assert.rejects(
    failedRefresh.client.recoverPlayer({ roomId: "room" }),
    (error) => error.code === "internal",
  );
  assert.equal(requests, 1);
  assert.deepEqual(failedRefresh.calls, [false, true]);
});

test("missing current user and session ending before token acquisition are safe", async () => {
  const missing = clientWith({ currentUser: false, fetchImpl: async () => assert.fail() });
  await assert.rejects(
    missing.client.recoverPlayer({ roomId: "room" }),
    (error) => error.code === "unauthenticated" && error.status === 401,
  );

  const ended = clientWith({
    tokens: [new Error("signed out")],
    fetchImpl: async () => assert.fail(),
  });
  await assert.rejects(
    ended.client.recoverPlayer({ roomId: "room" }),
    (error) => error.code === "internal",
  );
});

test("network, malformed JSON, empty JSON, HTTP 500 and 429 map to stable errors without retry", async () => {
  const cases = [
    {
      expected: "network-error",
      fetchImpl: async () => {
        throw new TypeError("connection refused");
      },
    },
    { expected: "network-error", fetchImpl: async () => response(200, null, { invalidJson: true }) },
    { expected: "internal", fetchImpl: async () => response(200, null) },
    {
      expected: "internal",
      fetchImpl: async () =>
        response(500, { ok: false, error: { code: "internal", message: "Request failed" } }),
    },
    {
      expected: "resource-exhausted",
      fetchImpl: async () =>
        response(429, {
          ok: false,
          error: { code: "resource-exhausted", message: "Try later" },
        }),
    },
  ];
  for (const entry of cases) {
    let requests = 0;
    const { client } = clientWith({
      fetchImpl: async (...args) => {
        requests += 1;
        return entry.fetchImpl(...args);
      },
    });
    await assert.rejects(
      client.submitAnswer({ roomId: "room" }),
      (error) => error.code === entry.expected,
    );
    assert.equal(requests, 1);
  }
});

test("normal and finalize calls honor bounded timeout/cancellation policies", async () => {
  const hangingFetch = async (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  for (const operation of ["submitAnswer", "finalizeQuestion"]) {
    const { client } = clientWith({ fetchImpl: hangingFetch, defaultTimeoutMs: 5 });
    await assert.rejects(
      client.call(operation, { roomId: "room" }, { timeoutMs: 5 }),
      (error) => error.code === "request-timeout",
    );
  }
});

test("HTTP and CORS boundaries reject unsafe input without stack traces", async () => {
  const disallowed = await invokeApi("player", {
    action: "recoverPlayer",
    origin: "https://attacker.example",
  });
  assert.equal(disallowed.statusCode, 403);
  assert.equal(disallowed.body.error.code, "origin-not-allowed");

  const options = await invokeApi("player", { method: "OPTIONS" });
  assert.equal(options.statusCode, 204);
  assert.equal(options.body, null);

  const get = await invokeApi("player", { method: "GET" });
  assert.equal(get.statusCode, 405);
  assert.equal(get.body.error.code, "method-not-allowed");

  const tooLarge = await invokeApi("player", {
    body: JSON.stringify({ action: "recoverPlayer", data: { value: "x".repeat(33 * 1024) } }),
  });
  assert.equal(tooLarge.statusCode, 413);
  assert.equal(tooLarge.body.error.code, "body-too-large");

  const invalidJson = await invokeApi("player", { body: "{" });
  assert.equal(invalidJson.statusCode, 400);
  assert.equal(invalidJson.body.error.code, "invalid-json");

  const wrongType = await invokeApi("player", {
    action: "recoverPlayer",
    headers: { "content-type": "text/plain" },
  });
  assert.equal(wrongType.statusCode, 415);
  assert.equal(wrongType.body.error.code, "unsupported-media-type");

  for (const result of [disallowed, get, tooLarge, invalidJson, wrongType]) {
    assert.equal(Object.hasOwn(result.body.error, "stack"), false);
  }
});

test("health metadata is safe and operational endpoints are POST-only", async () => {
  const health = await invokeApi("health", { method: "GET" });
  assert.deepEqual(health.body, {
    ok: true,
    data: { status: "ok", service: "family-quiz-vercel-api" },
  });
  const serialized = JSON.stringify(health.body);
  assert.doesNotMatch(serialized, /project|credential|token|phone|authUid|private/i);
});

test("browser/server import and PWA boundaries remain intact", async () => {
  const srcFiles = (await readdir(path.join(root, "src"), { recursive: true }))
    .filter((file) => /\.(?:js|jsx|ts|tsx)$/.test(file));
  for (const file of srcFiles) {
    const source = await readFile(path.join(root, "src", file), "utf8");
    assert.doesNotMatch(source, /firebase-admin|from\s+["'][^"']*(?:\/api\/|api\/)/);
    if (file !== "server-api-client.js") assert.doesNotMatch(source, /\bhttpsCallable\b/);
  }

  const buildInputs = await Promise.all(
    ["src/main.jsx", "vite.config.js", "index.html"].map((file) =>
      readFile(path.join(root, file), "utf8"),
    ),
  );
  assert.doesNotMatch(buildInputs.join("\n"), /serviceWorker|registerSW|workbox|caches\./);
  const clientCore = await readFile(path.join(root, "src/server-api-core.js"), "utf8");
  assert.match(clientCore, /cache:\s*["']no-store["']/);
  assert.doesNotMatch(clientCore, /localStorage|sessionStorage|CacheStorage/);
});
