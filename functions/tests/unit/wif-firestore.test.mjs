import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { Firestore } = require("@google-cloud/firestore");
const { IdentityPoolClient } = require("google-auth-library");
const {
  EXPECTED_VERCEL_AUDIENCE,
  EXPECTED_VERCEL_ISSUER,
  EXPECTED_VERCEL_SUBJECT,
} = require("../../server/environment-guard.js");
const { runWithVercelOidcRequest } = require("../../server/vercel-oidc.js");
const {
  closeWarmWifFirestore,
  createWarmWifFirestoreRuntime,
  ensureRequestWifCredential,
  externalAccountConfiguration,
  getRequestFirestore,
  runWithWifFirestoreRequest,
} = require("../../server/wif-firestore.js");

function stagingEnvironment(overrides = {}) {
  return {
    APP_ENVIRONMENT: "staging",
    SERVER_TRANSPORT: "vercel",
    VERCEL_ENV: "production",
    FIREBASE_ADMIN_AUTH_MODE: "oidc",
    FIREBASE_ADMIN_PROJECT_ID: "family-quiz-staging",
    FIREBASE_PRODUCTION_PROJECT_ID: "family-quiz-b7960",
    CONFIRM_STAGING_PROJECT: "family-quiz-staging",
    FIREBASE_DATABASE_URL: "https://family-quiz-staging-default-rtdb.firebaseio.com",
    STAGING_ORIGIN: "https://family-quiz-staging.vercel.app",
    VERCEL_ALLOWED_ORIGINS: "https://family-quiz-staging.vercel.app",
    PRODUCTION_ORIGIN: "https://family-quiz-psi.vercel.app",
    GOOGLE_CLOUD_PROJECT: "family-quiz-staging",
    GCP_PROJECT_NUMBER: "110839511131",
    GCP_WORKLOAD_IDENTITY_POOL_ID: "vercel-staging",
    GCP_WORKLOAD_IDENTITY_PROVIDER_ID: "vercel-staging",
    GCP_SERVICE_ACCOUNT_EMAIL:
      "vercel-staging-firebase-admin@family-quiz-staging.iam.gserviceaccount.com",
    VERCEL_OIDC_ISSUER: EXPECTED_VERCEL_ISSUER,
    VERCEL_OIDC_AUDIENCE: EXPECTED_VERCEL_AUDIENCE,
    VERCEL_OIDC_SUBJECT: EXPECTED_VERCEL_SUBJECT,
    ...overrides,
  };
}

function oidcToken(marker) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: EXPECTED_VERCEL_ISSUER,
    aud: EXPECTED_VERCEL_AUDIENCE,
    sub: EXPECTED_VERCEL_SUBJECT,
    marker,
    iat: now - 30,
    exp: now + 600,
  })).toString("base64url");
  return `${header}.${payload}.${marker}`;
}

function withOidcToken(token, callback) {
  return runWithVercelOidcRequest(
    { headers: { "x-vercel-oidc-token": token } },
    callback,
  );
}

test("official programmatic IdentityPoolClient replaces temporary credential files", async () => {
  const runtime = createWarmWifFirestoreRuntime(stagingEnvironment());
  try {
    const client = await runtime.auth.getClient();
    assert.ok(client instanceof IdentityPoolClient);
    assert.ok(runtime.firestore instanceof Firestore);
    assert.equal(runtime.firestore.doc("rooms/test-room").path, "rooms/test-room");
    assert.equal(JSON.stringify(externalAccountConfiguration(
      stagingEnvironment(),
      runtime.supplier,
    )).includes("subject-token.jwt"), false);
  } finally {
    await runtime.firestore.terminate();
  }
});

test("official Google auth performs mocked STS and service-account impersonation", async () => {
  const token = oidcToken("mocked-exchange");
  const runtime = createWarmWifFirestoreRuntime(stagingEnvironment());
  try {
    const client = await runtime.auth.getClient();
    const calls = [];
    client.stsCredential.transporter.request = async (options) => {
      calls.push({ stage: "sts", url: String(options.url) });
      return { data: {
        access_token: "mock-federated-access-token",
        expires_in: 600,
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
      } };
    };
    client.transporter.request = async (options) => {
      calls.push({ stage: "impersonation", url: String(options.url) });
      return { data: {
        accessToken: "mock-impersonated-access-token",
        expireTime: new Date(Date.now() + 600_000).toISOString(),
      } };
    };
    const access = await withOidcToken(token, () => client.getAccessToken());
    assert.equal(access.token, "mock-impersonated-access-token");
    assert.deepEqual(calls.map((call) => call.stage), ["sts", "impersonation"]);
    assert.match(calls[0].url, /^https:\/\/sts\.googleapis\.com\//);
    assert.match(calls[1].url, /^https:\/\/iamcredentials\.googleapis\.com\//);
    assert.equal(JSON.stringify(runtime).includes(token), false);
  } finally {
    await runtime.firestore.terminate();
  }
});

test("ten sequential requests reuse one Firestore client without request cleanup termination", async () => {
  const instances = [];
  class FakeFirestore {
    constructor(settings) {
      this.settings = settings;
      this.terminateCalls = 0;
      instances.push(this);
    }
    async terminate() { this.terminateCalls += 1; }
  }
  class FakeGoogleAuth {
    constructor(options) { this.options = options; }
    async getClient() { return { getAccessToken: async () => ({ token: "cached-access-token" }) }; }
  }
  const runtimeCache = { runtime: null, closing: null };
  const token = oidcToken("sequential");
  for (let index = 0; index < 10; index += 1) {
    await withOidcToken(token, () => runWithWifFirestoreRequest(
      stagingEnvironment(),
      async () => {
        await ensureRequestWifCredential();
        return getRequestFirestore();
      },
      { FirestoreClass: FakeFirestore, GoogleAuthClass: FakeGoogleAuth, runtimeCache },
    ));
  }
  assert.equal(instances.length, 1);
  assert.equal(instances[0].terminateCalls, 0);
  await closeWarmWifFirestore(runtimeCache);
  assert.equal(instances[0].terminateCalls, 1);
});

test("two concurrent requests never mix their raw Vercel subject tokens", async () => {
  class FakeFirestore { async terminate() {} }
  class FakeGoogleAuth {
    constructor(options) { this.options = options; }
    async getClient() { return { getAccessToken: async () => ({ token: "shared-gcp-access-token" }) }; }
  }
  const runtimeCache = { runtime: null, closing: null };
  const firstToken = oidcToken("first-request");
  const secondToken = oidcToken("second-request");
  const seen = [];
  const credentialReady = async (runtime) => {
    const token = await runtime.supplier.getSubjectToken({
      audience: runtime.supplier.audience,
      subjectTokenType: runtime.supplier.subjectTokenType,
    });
    await new Promise((resolve) => setTimeout(resolve, token === firstToken ? 20 : 5));
    seen.push(token);
  };
  const run = (token) => withOidcToken(token, () => runWithWifFirestoreRequest(
    stagingEnvironment(),
    async () => {
      await ensureRequestWifCredential();
      return runtimeCache.runtime.supplier.getSubjectToken({
        audience: runtimeCache.runtime.supplier.audience,
        subjectTokenType: runtimeCache.runtime.supplier.subjectTokenType,
      });
    },
    { FirestoreClass: FakeFirestore, GoogleAuthClass: FakeGoogleAuth, runtimeCache, credentialReady },
  ));
  const results = await Promise.all([run(firstToken), run(secondToken)]);
  assert.deepEqual(results, [firstToken, secondToken]);
  assert.deepEqual(new Set(seen), new Set([firstToken, secondToken]));
  assert.equal(JSON.stringify(runtimeCache.runtime).includes(firstToken), false);
  assert.equal(JSON.stringify(runtimeCache.runtime).includes(secondToken), false);
  await closeWarmWifFirestore(runtimeCache);
});

test("Production project configuration is rejected before a warm client is created", async () => {
  const runtimeCache = { runtime: null, closing: null };
  await assert.rejects(
    withOidcToken(oidcToken("production-rejected"), () => runWithWifFirestoreRequest(
      stagingEnvironment({ FIREBASE_ADMIN_PROJECT_ID: "family-quiz-b7960" }),
      () => undefined,
      { runtimeCache },
    )),
    /family-quiz-staging/,
  );
  assert.equal(runtimeCache.runtime, null);
});
