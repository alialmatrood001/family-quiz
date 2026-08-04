import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { Firestore } = require("@google-cloud/firestore");
const { GoogleAuth, IdentityPoolClient } = require("google-auth-library");
const {
  EXPECTED_VERCEL_AUDIENCE,
  EXPECTED_VERCEL_ISSUER,
  EXPECTED_VERCEL_SUBJECT,
} = require("../../server/environment-guard.js");
const {
  runWithVercelOidcRequest,
} = require("../../server/vercel-oidc.js");
const {
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

test("request-local Firestore uses the supported Google client without invalid-credential", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "family-quiz-wif-test-"));
  const token = oidcToken("supported-client");
  try {
    await withOidcToken(token, () =>
      runWithWifFirestoreRequest(
        stagingEnvironment(),
        async () => {
          const db = getRequestFirestore();
          assert.ok(db instanceof Firestore);
          assert.equal(db.doc("rooms/test-room").path, "rooms/test-room");
        },
        { temporaryDirectory: base },
      ),
    );
    assert.deepEqual(await readdir(base), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("official GoogleAuth loads the generated external account and mocks STS plus impersonation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "family-quiz-google-auth-test-"));
  const tokenPath = path.join(directory, "subject.jwt");
  const configurationPath = path.join(directory, "external-account.json");
  const token = oidcToken("mocked-exchange");
  try {
    await writeFile(tokenPath, token, { encoding: "utf8", mode: 0o600 });
    await writeFile(
      configurationPath,
      JSON.stringify(externalAccountConfiguration(stagingEnvironment(), tokenPath)),
      { encoding: "utf8", mode: 0o600 },
    );
    const auth = new GoogleAuth({
      keyFilename: configurationPath,
      projectId: "family-quiz-staging",
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    const client = await auth.getClient();
    assert.ok(client instanceof IdentityPoolClient);
    const calls = [];
    client.stsCredential.transporter.request = async (options) => {
      calls.push({ stage: "sts", url: String(options.url) });
      return {
        data: {
          access_token: "mock-federated-access-token",
          expires_in: 600,
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "Bearer",
        },
      };
    };
    client.transporter.request = async (options) => {
      calls.push({ stage: "impersonation", url: String(options.url) });
      return {
        data: {
          accessToken: "mock-impersonated-access-token",
          expireTime: new Date(Date.now() + 600_000).toISOString(),
        },
      };
    };
    const access = await client.getAccessToken();
    assert.equal(access.token, "mock-impersonated-access-token");
    assert.deepEqual(calls.map((call) => call.stage), ["sts", "impersonation"]);
    assert.match(calls[0].url, /^https:\/\/sts\.googleapis\.com\//);
    assert.match(calls[1].url, /^https:\/\/iamcredentials\.googleapis\.com\//);
    assert.equal(await readFile(tokenPath, "utf8"), token);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("two concurrent requests never share token files, clients, or lifecycle", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "family-quiz-wif-concurrency-"));
  const instances = [];
  class InspectingFirestore {
    constructor(settings) {
      this.settings = settings;
      this.configuration = JSON.parse(readFileSync(settings.keyFilename, "utf8"));
      this.token = readFileSync(this.configuration.credential_source.file, "utf8");
      this.terminated = false;
      instances.push(this);
    }
    async terminate() {
      this.terminated = true;
    }
  }
  const firstToken = oidcToken("first-request");
  const secondToken = oidcToken("second-request");
  try {
    const results = await Promise.all([
      withOidcToken(firstToken, () =>
        runWithWifFirestoreRequest(
          stagingEnvironment(),
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return getRequestFirestore().token;
          },
          { FirestoreClass: InspectingFirestore, temporaryDirectory: base },
        ),
      ),
      withOidcToken(secondToken, () =>
        runWithWifFirestoreRequest(
          stagingEnvironment(),
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return getRequestFirestore().token;
          },
          { FirestoreClass: InspectingFirestore, temporaryDirectory: base },
        ),
      ),
    ]);
    assert.deepEqual(results, [firstToken, secondToken]);
    assert.equal(instances.length, 2);
    assert.notEqual(instances[0].settings.keyFilename, instances[1].settings.keyFilename);
    assert.notEqual(
      instances[0].configuration.credential_source.file,
      instances[1].configuration.credential_source.file,
    );
    assert.ok(instances.every((instance) => instance.terminated));
    assert.deepEqual(await readdir(base), []);
    assert.equal(
      JSON.stringify(instances.map((instance) => instance.configuration)).includes(firstToken),
      false,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("Production project configuration is rejected before any temporary credential artifact", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "family-quiz-wif-production-"));
  try {
    await assert.rejects(
      withOidcToken(oidcToken("production-rejected"), () =>
        runWithWifFirestoreRequest(
          stagingEnvironment({ FIREBASE_ADMIN_PROJECT_ID: "family-quiz-b7960" }),
          () => undefined,
          { temporaryDirectory: base },
        ),
      ),
      /family-quiz-staging/,
    );
    assert.deepEqual(await readdir(base), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
