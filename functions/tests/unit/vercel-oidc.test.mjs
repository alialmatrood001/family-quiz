import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  emulatorConfiguration,
  productionConfiguration,
} = require("../../server/firebase-admin.js");
const {
  EXPECTED_VERCEL_AUDIENCE,
  EXPECTED_VERCEL_ISSUER,
  EXPECTED_VERCEL_SUBJECT,
  validateStagingServerEnvironment,
} = require("../../server/environment-guard.js");
const {
  GOOGLE_SCOPES,
  SUBJECT_TOKEN_TYPE,
  externalAccountOptions,
  runWithVercelOidcRequest,
  validateVercelOidcToken,
} = require("../../server/vercel-oidc.js");

function oidcEnvironment(overrides = {}) {
  return {
    APP_ENVIRONMENT: "staging",
    SERVER_TRANSPORT: "vercel",
    VERCEL_ENV: "production",
    FIREBASE_ADMIN_AUTH_MODE: "oidc",
    FIREBASE_ADMIN_PROJECT_ID: "family-quiz-staging",
    FIREBASE_PRODUCTION_PROJECT_ID: "family-quiz-b7960",
    CONFIRM_STAGING_PROJECT: "family-quiz-staging",
    FIREBASE_DATABASE_URL: "https://family-quiz-staging.firebaseio.com",
    STAGING_ORIGIN: "https://family-quiz-staging.vercel.app",
    PRODUCTION_ORIGIN: "https://family-quiz.com",
    VERCEL_ALLOWED_ORIGINS: "https://family-quiz-staging.vercel.app",
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

function testToken(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: EXPECTED_VERCEL_ISSUER,
      aud: EXPECTED_VERCEL_AUDIENCE,
      sub: EXPECTED_VERCEL_SUBJECT,
      iat: now,
      exp: now + 600,
      ...overrides,
    }),
  ).toString("base64url");
  return `${header}.${payload}.test-signature`;
}

test("emulator configuration remains credential-free and demo-only", () => {
  const result = emulatorConfiguration({
    FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
    FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
    FIREBASE_DATABASE_EMULATOR_HOST: "127.0.0.1:9000",
    GCLOUD_PROJECT: "demo-family-quiz",
  });
  assert.deepEqual(result, { projectId: "demo-family-quiz", mode: "emulator" });
  assert.equal(Object.hasOwn(result, "credential"), false);
});

test("complete staging OIDC configuration is accepted and builds an in-memory external account", () => {
  const env = oidcEnvironment();
  assert.equal(validateStagingServerEnvironment(env).authMode, "oidc");
  const options = externalAccountOptions(env);
  assert.equal(
    options.audience,
    "//iam.googleapis.com/projects/110839511131/locations/global/" +
      "workloadIdentityPools/vercel-staging/providers/vercel-staging",
  );
  assert.equal(options.subject_token_type, SUBJECT_TOKEN_TYPE);
  assert.match(options.service_account_impersonation_url, /generateAccessToken$/);
  assert.deepEqual(options.scopes, [...GOOGLE_SCOPES]);
  assert.equal(Object.hasOwn(options, "credential_source"), false);
});

test("missing, Production, issuer, audience, subject, and mixed credential profiles fail closed", () => {
  const cases = [
    [{ GCP_PROJECT_NUMBER: "" }, /GCP_PROJECT_NUMBER/],
    [{ VERCEL_ENV: "preview" }, /VERCEL_ENV/],
    [{ GCP_PROJECT_NUMBER: "123456789012" }, /GCP_PROJECT_NUMBER/],
    [{ GCP_WORKLOAD_IDENTITY_PROVIDER_ID: "vercel-oidc" }, /PROVIDER_ID/],
    [{ FIREBASE_ADMIN_PROJECT_ID: "family-quiz-b7960" }, /family-quiz-staging/],
    [{ VERCEL_OIDC_ISSUER: "https://oidc.vercel.com/other-team" }, /ISSUER/],
    [{ VERCEL_OIDC_AUDIENCE: "https://vercel.com/other-team" }, /AUDIENCE/],
    [
      {
        VERCEL_OIDC_SUBJECT:
          "owner:ali-almatrood-s-projects:project:other-project:environment:production",
      },
      /SUBJECT/,
    ],
    [
      {
        VERCEL_OIDC_SUBJECT:
          "owner:ali-almatrood-s-projects:project:family-quiz-staging:environment:preview",
      },
      /SUBJECT/,
    ],
    [{ FIREBASE_ADMIN_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----" }, /cannot be configured together/],
  ];
  for (const [overrides, expected] of cases) {
    assert.throws(() => validateStagingServerEnvironment(oidcEnvironment(overrides)), expected);
  }
});

test("Vercel token claims are preflight checked without trusting another project or environment", () => {
  assert.deepEqual(validateVercelOidcToken(testToken()), {
    issuerApproved: true,
    audienceApproved: true,
    subjectApproved: true,
  });
  assert.deepEqual(validateVercelOidcToken(testToken({ aud: ["unused", EXPECTED_VERCEL_AUDIENCE] })), {
    issuerApproved: true,
    audienceApproved: true,
    subjectApproved: true,
  });
  assert.throws(
    () => validateVercelOidcToken(testToken({ iss: "https://oidc.vercel.com/other-team" })),
    /issuer/,
  );
  assert.throws(
    () => validateVercelOidcToken(testToken({ aud: "https://vercel.com/other-team" })),
    /audience/,
  );
  assert.throws(
    () =>
      validateVercelOidcToken(
        testToken({
          sub: "owner:ali-almatrood-s-projects:project:other-project:environment:production",
        }),
      ),
    /subject/,
  );
});

test("OIDC token material is never logged", () => {
  const token = testToken();
  const output = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values) => output.push(values.join(" "));
  console.error = (...values) => output.push(values.join(" "));
  try {
    assert.throws(
      () =>
        runWithVercelOidcRequest(
          { headers: { "x-vercel-oidc-token": testToken({ aud: "wrong" }) } },
          () => undefined,
        ),
      /audience/,
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.doesNotMatch(output.join("\n"), new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("Firebase Auth initializer stays keyless and does not receive the unsupported custom credential", () => {
  const config = productionConfiguration(oidcEnvironment());
  assert.equal(config.mode, "vercel-oidc");
  assert.equal(config.projectId, "family-quiz-staging");
  assert.equal(Object.hasOwn(config, "credential"), false);
});
