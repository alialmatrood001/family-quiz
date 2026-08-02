import assert from "node:assert/strict";
import test from "node:test";
import { invokeApi } from "../helpers/local-vercel-api.mjs";

const MANAGED_KEYS = [
  "APP_ENVIRONMENT",
  "SERVER_TRANSPORT",
  "STAGING_ORIGIN",
  "PRODUCTION_ORIGIN",
  "VERCEL_ALLOWED_ORIGINS",
];

function stagingEnvironment() {
  return {
    APP_ENVIRONMENT: "staging",
    SERVER_TRANSPORT: "vercel",
    STAGING_ORIGIN: "https://family-quiz-staging.vercel.app",
    PRODUCTION_ORIGIN: "https://family-quiz.com",
    VERCEL_ALLOWED_ORIGINS: "https://family-quiz-staging.vercel.app",
  };
}

function withEnvironment(t, values) {
  const previous = Object.fromEntries(MANAGED_KEYS.map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  for (const key of MANAGED_KEYS) {
    if (!(key in values)) delete process.env[key];
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("staging health reports safe metadata with no-store headers", async (t) => {
  withEnvironment(t, stagingEnvironment());
  process.env.OPERATION11_TEST_SECRET = "must-never-appear";
  t.after(() => delete process.env.OPERATION11_TEST_SECRET);
  const response = await invokeApi("health", {
    method: "GET",
    origin: "https://family-quiz-staging.vercel.app",
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    ok: true,
    data: {
      status: "ok",
      service: "family-quiz-vercel-api",
      environment: "staging",
      transport: "vercel",
    },
  });
  assert.equal(response.headers["cache-control"], "no-store, max-age=0");
  assert.equal(response.headers.pragma, "no-cache");
  assert.equal(response.headers["access-control-allow-methods"], "GET, OPTIONS");
  assert.doesNotMatch(JSON.stringify(response.body), /must-never-appear|credential|private.key/i);
});

test("staging CORS allows only the exact staging origin plus local test origins", async (t) => {
  withEnvironment(t, stagingEnvironment());
  const allowed = await invokeApi("health", {
    method: "GET",
    origin: "https://family-quiz-staging.vercel.app",
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal(
    allowed.headers["access-control-allow-origin"],
    "https://family-quiz-staging.vercel.app",
  );
  const local = await invokeApi("health", {
    method: "GET",
    origin: "http://127.0.0.1:5173",
  });
  assert.equal(local.statusCode, 200);
  for (const origin of [
    "https://family-quiz.com",
    "https://attacker.example",
    "https://family-quiz-staging.vercel.app.attacker.example",
  ]) {
    const denied = await invokeApi("health", { method: "GET", origin });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.body.error.code, "origin-not-allowed");
  }
});

test("missing or mixed staging CORS configuration fails closed", async (t) => {
  withEnvironment(t, {
    ...stagingEnvironment(),
    VERCEL_ALLOWED_ORIGINS: "https://family-quiz.com",
  });
  const response = await invokeApi("health", {
    method: "GET",
    origin: "https://family-quiz-staging.vercel.app",
  });
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.error.code, "staging-configuration-invalid");
  assert.equal(Object.hasOwn(response.body.error, "stack"), false);
  assert.equal(response.headers["cache-control"], "no-store, max-age=0");
});
