import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { environmentGuardDiagnostic } from "../../../api/_lib/http.js";

const require = createRequire(import.meta.url);
const { validateStagingServerEnvironment } = require("../../server/environment-guard.js");

function liveStagingEnvironment(overrides = {}) {
  return {
    APP_ENVIRONMENT: "staging",
    SERVER_TRANSPORT: "vercel",
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
    VERCEL_ENV: "production",
    ...overrides,
  };
}

function legacyEnvironment(overrides = {}) {
  const env = liveStagingEnvironment({
    FIREBASE_ADMIN_AUTH_MODE: "legacy-key",
    FIREBASE_ADMIN_CLIENT_EMAIL:
      "firebase-adminsdk-test@family-quiz-staging.iam.gserviceaccount.com",
    FIREBASE_ADMIN_PRIVATE_KEY:
      "-----BEGIN PRIVATE KEY-----\nTEST-ONLY\n-----END PRIVATE KEY-----",
    ...overrides,
  });
  for (const name of [
    "GCP_PROJECT_NUMBER",
    "GCP_WORKLOAD_IDENTITY_POOL_ID",
    "GCP_WORKLOAD_IDENTITY_PROVIDER_ID",
    "GCP_SERVICE_ACCOUNT_EMAIL",
    "VERCEL_OIDC_ISSUER",
    "VERCEL_OIDC_AUDIENCE",
    "VERCEL_OIDC_SUBJECT",
  ]) {
    if (!Object.hasOwn(overrides, name)) delete env[name];
  }
  return env;
}

test("the literal live Vercel staging values pass every environment guard", () => {
  const result = validateStagingServerEnvironment(liveStagingEnvironment());
  assert.equal(result.projectId, "family-quiz-staging");
  assert.equal(result.databaseURL, "https://family-quiz-staging-default-rtdb.firebaseio.com");
  assert.equal(result.authMode, "oidc");
});

test("unreferenced Vercel system URL metadata does not change the isolated staging decision", () => {
  const result = validateStagingServerEnvironment(liveStagingEnvironment({
    VERCEL_URL: "family-quiz-staging-random.vercel.app",
    VERCEL_PROJECT_PRODUCTION_URL: "family-quiz-staging.vercel.app",
    HOST: "family-quiz-staging-random.vercel.app",
    VERCEL_PROJECT_ID: "prj_test_only",
    VERCEL_TARGET_ENV: "production",
  }));
  assert.equal(result.environment, "staging");
});

test("safe whitespace normalization and supported RTDB trailing slash are accepted", () => {
  const result = validateStagingServerEnvironment(liveStagingEnvironment({
    APP_ENVIRONMENT: " staging ",
    FIREBASE_DATABASE_URL:
      " https://family-quiz-staging-default-rtdb.firebaseio.com/ ",
    STAGING_ORIGIN: " https://family-quiz-staging.vercel.app ",
    PRODUCTION_ORIGIN: " https://family-quiz-psi.vercel.app ",
    VERCEL_ALLOWED_ORIGINS: " https://family-quiz-staging.vercel.app ",
  }));
  assert.equal(result.databaseURL, "https://family-quiz-staging-default-rtdb.firebaseio.com/");
  assert.equal(result.stagingOrigin, "https://family-quiz-staging.vercel.app");
});

test("HTTP logging metadata identifies a guard failure without exposing credential material", () => {
  const privateKey = "test-only-private-key-material";
  let caught;
  try {
    validateStagingServerEnvironment(liveStagingEnvironment({
      FIREBASE_ADMIN_PRIVATE_KEY: privateKey,
    }));
  } catch (error) {
    caught = error;
  }
  const diagnostic = environmentGuardDiagnostic(caught);
  assert.deepEqual(diagnostic, {
    failedCheck: "no-legacy-private-key-in-oidc",
    configurationVariable: "FIREBASE_ADMIN_PRIVATE_KEY",
    expectedValue: "absent",
    actualValue: "present",
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), new RegExp(privateKey));
});

const oidcFailureCases = [
  ["APP_ENVIRONMENT blocks non-staging", { APP_ENVIRONMENT: "production" }, "staging-environment", "APP_ENVIRONMENT"],
  ["SERVER_TRANSPORT blocks callable", { SERVER_TRANSPORT: "callable" }, "vercel-transport", "SERVER_TRANSPORT"],
  ["VERCEL_ENV blocks Preview", { VERCEL_ENV: "preview" }, "isolated-vercel-production-environment", "VERCEL_ENV"],
  ["service-account file paths are forbidden", { GOOGLE_APPLICATION_CREDENTIALS: "secret.json" }, "no-service-account-file", "GOOGLE_APPLICATION_CREDENTIALS"],
  ["staging project is exact", { FIREBASE_ADMIN_PROJECT_ID: "family-quiz-b7960" }, "approved-staging-project", "FIREBASE_ADMIN_PROJECT_ID"],
  ["known Production project is exact", { FIREBASE_PRODUCTION_PROJECT_ID: "old-production" }, "known-production-project", "FIREBASE_PRODUCTION_PROJECT_ID"],
  ["staging confirmation must match", { CONFIRM_STAGING_PROJECT: "different-staging" }, "confirmed-staging-project", "CONFIRM_STAGING_PROJECT"],
  ["database URL must parse", { FIREBASE_DATABASE_URL: "not-a-url" }, "staging-database-url", "FIREBASE_DATABASE_URL"],
  ["database host must belong to Staging", { FIREBASE_DATABASE_URL: "https://family-quiz-b7960.firebaseio.com" }, "staging-database-host", "FIREBASE_DATABASE_URL"],
  ["staging origin must be HTTPS", { STAGING_ORIGIN: "http://family-quiz-staging.vercel.app" }, "https-origin", "STAGING_ORIGIN"],
  ["Production origin cannot contain a path", { PRODUCTION_ORIGIN: "https://family-quiz-psi.vercel.app/path" }, "https-origin", "PRODUCTION_ORIGIN"],
  ["staging and Production origins differ", { PRODUCTION_ORIGIN: "https://family-quiz-staging.vercel.app" }, "staging-production-origin-separation", "PRODUCTION_ORIGIN"],
  ["only the staging origin is allowed", { VERCEL_ALLOWED_ORIGINS: "https://family-quiz-staging.vercel.app,https://family-quiz-psi.vercel.app" }, "staging-origin-only", "VERCEL_ALLOWED_ORIGINS"],
  ["admin auth mode is explicit", { FIREBASE_ADMIN_AUTH_MODE: "application-default" }, "supported-admin-auth-mode", "FIREBASE_ADMIN_AUTH_MODE"],
  ["OIDC forbids a legacy client email", { FIREBASE_ADMIN_CLIENT_EMAIL: "old@family-quiz-staging.iam.gserviceaccount.com" }, "no-legacy-client-email-in-oidc", "FIREBASE_ADMIN_CLIENT_EMAIL"],
  ["OIDC forbids a legacy private key", { FIREBASE_ADMIN_PRIVATE_KEY: "private-value" }, "no-legacy-private-key-in-oidc", "FIREBASE_ADMIN_PRIVATE_KEY"],
  ["Google Cloud project is exact", { GOOGLE_CLOUD_PROJECT: "family-quiz-b7960" }, "oidc-google-project", "GOOGLE_CLOUD_PROJECT"],
  ["GCP project number is exact", { GCP_PROJECT_NUMBER: "999" }, "oidc-project-number", "GCP_PROJECT_NUMBER"],
  ["WIF pool is exact", { GCP_WORKLOAD_IDENTITY_POOL_ID: "vercel-oidc" }, "oidc-pool-id", "GCP_WORKLOAD_IDENTITY_POOL_ID"],
  ["WIF provider is exact", { GCP_WORKLOAD_IDENTITY_PROVIDER_ID: "vercel-oidc" }, "oidc-provider-id", "GCP_WORKLOAD_IDENTITY_PROVIDER_ID"],
  ["service account is exact", { GCP_SERVICE_ACCOUNT_EMAIL: "other@family-quiz-staging.iam.gserviceaccount.com" }, "oidc-service-account", "GCP_SERVICE_ACCOUNT_EMAIL"],
  ["OIDC issuer is exact", { VERCEL_OIDC_ISSUER: "https://oidc.vercel.com/other" }, "approved-vercel-oidc-identity", "VERCEL_OIDC_ISSUER"],
  ["OIDC audience is exact", { VERCEL_OIDC_AUDIENCE: "https://vercel.com/other" }, "approved-vercel-oidc-identity", "VERCEL_OIDC_AUDIENCE"],
  ["OIDC subject is exact", { VERCEL_OIDC_SUBJECT: "owner:other" }, "approved-vercel-oidc-identity", "VERCEL_OIDC_SUBJECT"],
  ["placeholder values are rejected", { VERCEL_OIDC_SUBJECT: "REPLACE_WITH_SUBJECT" }, "required-variable", "VERCEL_OIDC_SUBJECT"],
];

for (const [name, overrides, failedCheck, configurationVariable] of oidcFailureCases) {
  test(name, () => {
    assert.throws(
      () => validateStagingServerEnvironment(liveStagingEnvironment(overrides)),
      (error) => {
        assert.equal(error.diagnosticStage, "environment-guard");
        assert.equal(error.failedCheck, failedCheck);
        assert.equal(error.configurationVariable, configurationVariable);
        assert.equal(typeof error.expectedValue, "string");
        assert.ok(error.expectedValue.length > 0);
        assert.equal(typeof error.actualValue, "string");
        assert.ok(error.actualValue.length > 0);
        assert.notEqual(error.configurationVariable, null);
        if (configurationVariable === "FIREBASE_ADMIN_PRIVATE_KEY") {
          assert.doesNotMatch(error.actualValue, /private-value/);
        }
        return true;
      },
    );
  });
}

for (const variable of [
  "GCP_PROJECT_NUMBER",
  "GCP_WORKLOAD_IDENTITY_POOL_ID",
  "GCP_WORKLOAD_IDENTITY_PROVIDER_ID",
  "GCP_SERVICE_ACCOUNT_EMAIL",
  "VERCEL_OIDC_ISSUER",
  "VERCEL_OIDC_AUDIENCE",
  "VERCEL_OIDC_SUBJECT",
]) {
  test(`legacy mode rejects mixed OIDC variable ${variable}`, () => {
    assert.throws(
      () => validateStagingServerEnvironment(legacyEnvironment({ [variable]: "configured" })),
      (error) =>
        error.failedCheck === "no-mixed-admin-credentials" &&
        error.configurationVariable === variable &&
        error.configurationVariable !== null,
    );
  });
}

const legacyFailureCases = [
  ["legacy client email is required", { FIREBASE_ADMIN_CLIENT_EMAIL: "" }, "required-variable", "FIREBASE_ADMIN_CLIENT_EMAIL"],
  ["legacy private key is required", { FIREBASE_ADMIN_PRIVATE_KEY: "" }, "required-variable", "FIREBASE_ADMIN_PRIVATE_KEY"],
  ["legacy email belongs to Staging", { FIREBASE_ADMIN_CLIENT_EMAIL: "admin@family-quiz-b7960.iam.gserviceaccount.com" }, "staging-service-account-domain", "FIREBASE_ADMIN_CLIENT_EMAIL"],
  ["legacy private key format is checked", { FIREBASE_ADMIN_PRIVATE_KEY: "invalid-secret" }, "private-key-format", "FIREBASE_ADMIN_PRIVATE_KEY"],
];

for (const [name, overrides, failedCheck, configurationVariable] of legacyFailureCases) {
  test(name, () => {
    assert.throws(
      () => validateStagingServerEnvironment(legacyEnvironment(overrides)),
      (error) => {
        assert.equal(error.failedCheck, failedCheck);
        assert.equal(error.configurationVariable, configurationVariable);
        assert.notEqual(error.configurationVariable, null);
        if (configurationVariable === "FIREBASE_ADMIN_PRIVATE_KEY") {
          assert.doesNotMatch(error.actualValue, /invalid-secret|PRIVATE KEY/);
        }
        return true;
      },
    );
  });
}
