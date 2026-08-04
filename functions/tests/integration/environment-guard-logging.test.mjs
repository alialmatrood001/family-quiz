import assert from "node:assert/strict";
import test from "node:test";
import { invokeApi } from "../helpers/local-vercel-api.mjs";

const ENVIRONMENT_KEYS = [
  "APP_ENVIRONMENT",
  "SERVER_TRANSPORT",
  "VERCEL_ENV",
  "FIREBASE_ADMIN_AUTH_MODE",
  "FIREBASE_ADMIN_PROJECT_ID",
  "FIREBASE_PRODUCTION_PROJECT_ID",
  "CONFIRM_STAGING_PROJECT",
  "FIREBASE_DATABASE_URL",
  "STAGING_ORIGIN",
  "VERCEL_ALLOWED_ORIGINS",
  "PRODUCTION_ORIGIN",
  "GOOGLE_CLOUD_PROJECT",
  "GCP_PROJECT_NUMBER",
  "GCP_WORKLOAD_IDENTITY_POOL_ID",
  "GCP_WORKLOAD_IDENTITY_PROVIDER_ID",
  "GCP_SERVICE_ACCOUNT_EMAIL",
  "VERCEL_OIDC_ISSUER",
  "VERCEL_OIDC_AUDIENCE",
  "VERCEL_OIDC_SUBJECT",
  "FIREBASE_ADMIN_CLIENT_EMAIL",
  "FIREBASE_ADMIN_PRIVATE_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "FIRESTORE_EMULATOR_HOST",
  "FIREBASE_AUTH_EMULATOR_HOST",
  "FIREBASE_DATABASE_EMULATOR_HOST",
  "FIREBASE_CONFIG",
  "K_SERVICE",
  "FUNCTION_TARGET",
];

function stagingEnvironment(overrides = {}) {
  return {
    APP_ENVIRONMENT: "staging",
    SERVER_TRANSPORT: "vercel",
    VERCEL_ENV: "production",
    FIREBASE_ADMIN_AUTH_MODE: "oidc",
    FIREBASE_ADMIN_PROJECT_ID: "family-quiz-staging",
    FIREBASE_PRODUCTION_PROJECT_ID: "family-quiz-b7960",
    CONFIRM_STAGING_PROJECT: "family-quiz-staging",
    FIREBASE_DATABASE_URL:
      "https://family-quiz-staging-default-rtdb.firebaseio.com",
    STAGING_ORIGIN: "https://family-quiz-staging.vercel.app",
    VERCEL_ALLOWED_ORIGINS: "https://family-quiz-staging.vercel.app",
    PRODUCTION_ORIGIN: "https://family-quiz-psi.vercel.app",
    GOOGLE_CLOUD_PROJECT: "family-quiz-staging",
    GCP_PROJECT_NUMBER: "110839511131",
    GCP_WORKLOAD_IDENTITY_POOL_ID: "vercel-staging",
    GCP_WORKLOAD_IDENTITY_PROVIDER_ID: "vercel-staging",
    GCP_SERVICE_ACCOUNT_EMAIL:
      "vercel-staging-firebase-admin@family-quiz-staging.iam.gserviceaccount.com",
    VERCEL_OIDC_ISSUER: "https://oidc.vercel.com/ali-almatrood-s-projects",
    VERCEL_OIDC_AUDIENCE: "https://vercel.com/ali-almatrood-s-projects",
    VERCEL_OIDC_SUBJECT:
      "owner:ali-almatrood-s-projects:project:family-quiz-staging:environment:production",
    ...overrides,
  };
}

function useEnvironment(t, values) {
  const previous = Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENVIRONMENT_KEYS) delete process.env[key];
  Object.assign(process.env, values);
  t.after(() => {
    for (const key of ENVIRONMENT_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(previous)) {
      if (value !== undefined) process.env[key] = value;
    }
  });
}

function jwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.test-signature`;
}

function requestTokens() {
  const now = Math.floor(Date.now() / 1000);
  return {
    firebase: jwt({
      aud: "family-quiz-staging",
      iss: "https://securetoken.google.com/family-quiz-staging",
      sub: "integration-admin",
      uid: "integration-admin",
      admin: true,
      iat: now - 30,
      exp: now + 600,
    }),
    vercel: jwt({
      iss: "https://oidc.vercel.com/ali-almatrood-s-projects",
      aud: "https://vercel.com/ali-almatrood-s-projects",
      sub: "owner:ali-almatrood-s-projects:project:family-quiz-staging:environment:production",
      iat: now - 30,
      exp: now + 600,
    }),
  };
}

function captureDiagnostics(t) {
  const entries = [];
  const original = console.error;
  console.error = (...values) => entries.push(values);
  t.after(() => {
    console.error = original;
  });
  return entries;
}

async function invokeAdmin(tokens) {
  return invokeApi("admin", {
    token: tokens.firebase,
    action: "initializeQuiz",
    data: {},
    origin: "https://family-quiz-staging.vercel.app",
    headers: { "x-vercel-oidc-token": tokens.vercel },
  });
}

test("a real Environment Guard failure retains safe metadata through /api/admin", async (t) => {
  const secret = "test-only-private-key-material";
  useEnvironment(t, stagingEnvironment({ FIREBASE_ADMIN_PRIVATE_KEY: secret }));
  const entries = captureDiagnostics(t);
  const tokens = requestTokens();

  const response = await invokeAdmin(tokens);

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, {
    ok: false,
    error: {
      code: "server-configuration-error",
      message: "Server authentication configuration is invalid",
    },
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0][0], "staging-server-auth-diagnostic");
  assert.deepEqual(entries[0][1], {
    failedStage: "environment-guard",
    failedCheck: "no-legacy-private-key-in-oidc",
    configurationVariable: "FIREBASE_ADMIN_PRIVATE_KEY",
    expectedValue: "absent",
    actualValue: "present",
    errorCode: "server-configuration-error",
  });
  const serialized = JSON.stringify({ entries, response: response.body });
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.doesNotMatch(serialized, new RegExp(tokens.firebase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(serialized, new RegExp(tokens.vercel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
