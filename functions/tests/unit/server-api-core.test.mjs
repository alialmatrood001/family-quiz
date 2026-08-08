import assert from "node:assert/strict";
import test from "node:test";
import {
  SERVER_OPERATIONS,
  ServerApiError,
  createServerApiClient,
  resolveServerTransport,
} from "../../../src/server-api-core.js";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function authWithTokens(tokens = ["token"]) {
  const refreshCalls = [];
  return {
    refreshCalls,
    auth: {
      currentUser: {
        async getIdToken(forceRefresh) {
          refreshCalls.push(forceRefresh);
          return tokens[Math.min(refreshCalls.length - 1, tokens.length - 1)];
        },
      },
    },
  };
}

test("server transport defaults to callable and supports explicit vercel", () => {
  assert.equal(resolveServerTransport(), "callable");
  assert.equal(resolveServerTransport(""), "callable");
  assert.equal(resolveServerTransport("callable"), "callable");
  assert.equal(resolveServerTransport("vercel"), "vercel");
});

test("unknown server transport fails clearly", () => {
  assert.throws(
    () => resolveServerTransport("silent-fallback"),
    (error) => error instanceof ServerApiError && error.code === "invalid-server-transport",
  );
});

test("client exposes all twenty server operations", () => {
  const client = createServerApiClient({
    transport: "callable",
    callableInvoker: async () => ({}),
  });
  assert.equal(Object.keys(SERVER_OPERATIONS).length, 20);
  for (const operation of Object.keys(SERVER_OPERATIONS)) {
    assert.equal(typeof client[operation], "function");
  }
});

test("Vercel request uses relative endpoint, bearer token, no-store, and strips uid fields", async () => {
  const identity = authWithTokens(["fresh-token"]);
  let request;
  const client = createServerApiClient({
    transport: "vercel",
    auth: identity.auth,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse(200, { ok: true, data: { status: "received" } });
    },
  });
  const result = await client.submitAnswer({
    roomId: "room",
    questionId: "question",
    playerId: "player",
    selectedIndex: 1,
    uid: "untrusted",
    authUid: "untrusted",
  });
  assert.deepEqual(result, { status: "received" });
  assert.equal(request.url, "/api/player");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.cache, "no-store");
  assert.equal(request.options.headers.Authorization, "Bearer fresh-token");
  const body = JSON.parse(request.options.body);
  assert.equal(body.action, "submitAnswer");
  assert.equal(body.data.uid, undefined);
  assert.equal(body.data.authUid, undefined);
  assert.equal(body.data.playerId, "player");
});

test("Vercel error becomes ServerApiError with stable fields", async () => {
  const identity = authWithTokens();
  const client = createServerApiClient({
    transport: "vercel",
    auth: identity.auth,
    fetchImpl: async () =>
      jsonResponse(403, {
        ok: false,
        error: { code: "permission-denied", message: "Admin permission is required" },
      }),
  });
  await assert.rejects(
    client.resetQuizData({ roomId: "room", mode: "full", reason: "test" }),
    (error) =>
      error instanceof ServerApiError &&
      error.code === "permission-denied" &&
      error.status === 403 &&
      !("stack" in JSON.parse(JSON.stringify(error))),
  );
});

test("401 refreshes the ID token once and retries once", async () => {
  const identity = authWithTokens(["expired-token", "refreshed-token"]);
  const seenTokens = [];
  const client = createServerApiClient({
    transport: "vercel",
    auth: identity.auth,
    fetchImpl: async (_url, options) => {
      seenTokens.push(options.headers.Authorization);
      return seenTokens.length === 1
        ? jsonResponse(401, {
            ok: false,
            error: { code: "invalid-token", message: "Authentication token is invalid" },
          })
        : jsonResponse(200, { ok: true, data: { status: "recovered" } });
    },
  });
  assert.deepEqual(await client.recoverPlayer({ roomId: "room" }), { status: "recovered" });
  assert.deepEqual(identity.refreshCalls, [false, true]);
  assert.deepEqual(seenTokens, ["Bearer expired-token", "Bearer refreshed-token"]);
});

test("a failed refreshed token does not cause a retry loop", async () => {
  const identity = authWithTokens(["expired-token", "still-invalid"]);
  let requests = 0;
  const client = createServerApiClient({
    transport: "vercel",
    auth: identity.auth,
    fetchImpl: async () => {
      requests += 1;
      return jsonResponse(401, {
        ok: false,
        error: { code: "invalid-token", message: "Authentication token is invalid" },
      });
    },
  });
  await assert.rejects(
    client.registerPlayer({ roomId: "room" }),
    (error) => error.code === "invalid-token",
  );
  assert.equal(requests, 2);
  assert.deepEqual(identity.refreshCalls, [false, true]);
});

test("request timeout aborts fetch with request-timeout", async () => {
  const identity = authWithTokens();
  const client = createServerApiClient({
    transport: "vercel",
    auth: identity.auth,
    defaultTimeoutMs: 5,
    fetchImpl: async (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });
  await assert.rejects(
    client.submitAnswer({ roomId: "room" }),
    (error) => error.code === "request-timeout",
  );
});

test("network failure is normalized without retry", async () => {
  const identity = authWithTokens();
  let requests = 0;
  const client = createServerApiClient({
    transport: "vercel",
    auth: identity.auth,
    fetchImpl: async () => {
      requests += 1;
      throw new TypeError("connection failed");
    },
  });
  await assert.rejects(
    client.activateJoker({ roomId: "room" }),
    (error) => error instanceof ServerApiError && error.code === "network-error",
  );
  assert.equal(requests, 1);
});

test("callable and Vercel return the same data shape", async () => {
  const expected = { success: true, status: "started" };
  const callable = createServerApiClient({
    transport: "callable",
    callableInvoker: async () => expected,
  });
  const identity = authWithTokens();
  const vercel = createServerApiClient({
    transport: "vercel",
    auth: identity.auth,
    fetchImpl: async () => jsonResponse(200, { ok: true, data: expected }),
  });
  assert.deepEqual(await callable.startQuestion({ roomId: "room" }), expected);
  assert.deepEqual(await vercel.startQuestion({ roomId: "room" }), expected);
});

test("finalizeQuestion has the longer bounded timeout policy", () => {
  assert.equal(SERVER_OPERATIONS.finalizeQuestion.timeoutMs, 25_000);
  assert.equal(SERVER_OPERATIONS.submitAnswer.timeoutMs, undefined);
});

test("Vercel transport emits safe token, HTTP, and total timing metadata", async () => {
  const timings = [];
  let clock = 0;
  const client = createServerApiClient({
    transport: "vercel",
    auth: { currentUser: { getIdToken: async () => { clock += 2; return "header.payload.signature"; } } },
    fetchImpl: async () => {
      clock += 8;
      return jsonResponse(200, { ok: true, data: { status: "received" } });
    },
    now: () => clock,
    onTiming: (entry) => timings.push(entry),
  });
  await client.submitAnswer({ roomId: "room", questionId: "q1", playerId: "p1", selectedIndex: 0 });
  assert.deepEqual(timings.map(({ phase }) => phase), ["auth-token", "http", "total"]);
  assert.deepEqual(timings.map(({ durationMs }) => durationMs), [2, 8, 10]);
  assert.equal(JSON.stringify(timings).includes("header.payload.signature"), false);
});
