import assert from "node:assert/strict";
import test from "node:test";

import { createActionEndpoint } from "../../../api/_lib/http.js";

const timing = await import("../../server/request-timing.js");
const {
  TIMING_FIELDS,
  measureServerTiming,
  runWithServerTimings,
  serverTimingHeader,
  serverTimingSnapshot,
} = timing.default || timing;

function token(projectId = "demo-family-quiz") {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    aud: projectId,
    iss: `https://securetoken.google.com/${projectId}`,
    sub: "safe-test-user",
    uid: "safe-test-user",
    admin: true,
    exp: now + 300,
  })).toString("base64url");
  return `header.${payload}.`;
}

function responseRecorder() {
  return {
    headers: {}, statusCode: 0, body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() {},
  };
}

test("structured timing snapshot and header contain only approved metrics", async () => {
  let clock = 10;
  const snapshot = await runWithServerTimings(async () => {
    await measureServerTiming("wifCredentialMs", async () => { clock += 4; });
    clock += 2;
    return serverTimingSnapshot();
  }, { now: () => clock });
  assert.equal(snapshot.wifCredentialMs, 4);
  assert.equal(snapshot.requestTotalMs, 6);
  assert.deepEqual(Object.keys(snapshot), [...TIMING_FIELDS]);
  const header = serverTimingHeader(snapshot);
  for (const field of TIMING_FIELDS) assert.match(header, new RegExp(`${field};dur=`));
  assert.doesNotMatch(header, /Bearer|header\.|safe-test-user|@/i);
});

test("concurrent timing contexts remain isolated", async () => {
  const run = (delay) => runWithServerTimings(async () => {
    await measureServerTiming("firestoreOperationMs", () =>
      new Promise((resolve) => setTimeout(resolve, delay)),
    );
    return serverTimingSnapshot();
  });
  const [slow, fast] = await Promise.all([run(20), run(5)]);
  assert.ok(slow.firestoreOperationMs >= fast.firestoreOperationMs);
  assert.ok(slow.requestTotalMs >= fast.requestTotalMs);
});

test("Vercel action response exposes safe Server-Timing metrics", async () => {
  const previous = Object.fromEntries([
    "APP_ENVIRONMENT", "FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST",
    "FIREBASE_DATABASE_EMULATOR_HOST", "GCLOUD_PROJECT",
  ].map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    APP_ENVIRONMENT: "staging",
    FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
    FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
    FIREBASE_DATABASE_EMULATOR_HOST: "127.0.0.1:9000",
    GCLOUD_PROJECT: "demo-family-quiz",
  });
  const safeLogs = [];
  const originalInfo = console.info;
  console.info = (...args) => safeLogs.push(args);
  try {
    const runtime = {
      projectId: "demo-family-quiz",
      auth: { verifyIdToken: async () => ({
        aud: "demo-family-quiz",
        iss: "https://securetoken.google.com/demo-family-quiz",
        sub: "safe-test-user",
        uid: "safe-test-user",
        admin: true,
      }) },
      operations: { probe: async () => ({ status: "ok" }) },
    };
    const endpoint = createActionEndpoint({
      actions: ["probe"],
      adminOnly: true,
      runtimeFactory: () => runtime,
    });
    const res = responseRecorder();
    await endpoint({
      method: "POST",
      headers: {
        authorization: `Bearer ${token()}`,
        "content-type": "application/json",
      },
      body: { action: "probe", data: {} },
    }, res);
    assert.equal(res.statusCode, 200);
    for (const field of TIMING_FIELDS) {
      assert.match(res.headers["Server-Timing"], new RegExp(`${field};dur=`));
    }
    const renderedLogs = JSON.stringify(safeLogs);
    assert.doesNotMatch(renderedLogs, /safe-test-user|Bearer|header\./);
    assert.match(renderedLogs, /staging-server-timing/);
  } finally {
    console.info = originalInfo;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
