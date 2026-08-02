import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  EXPECTED_GCP_PROJECT_NUMBER,
  EXPECTED_SERVICE_ACCOUNT_EMAIL,
  EXPECTED_STAGING_PROJECT_ID,
  EXPECTED_VERCEL_AUDIENCE,
  EXPECTED_VERCEL_ISSUER,
  EXPECTED_VERCEL_SUBJECT,
  EXPECTED_WIF_POOL_ID,
  EXPECTED_WIF_PROVIDER_ID,
  validateStagingServerEnvironment,
} = require("../functions/server/environment-guard.js");
const { externalAccountOptions } = require("../functions/server/vercel-oidc.js");

const safeCanonicalEnvironment = {
  APP_ENVIRONMENT: "staging",
  SERVER_TRANSPORT: "vercel",
  VERCEL_ENV: "production",
  FIREBASE_ADMIN_AUTH_MODE: "oidc",
  FIREBASE_ADMIN_PROJECT_ID: EXPECTED_STAGING_PROJECT_ID,
  FIREBASE_PRODUCTION_PROJECT_ID: "family-quiz-b7960",
  CONFIRM_STAGING_PROJECT: EXPECTED_STAGING_PROJECT_ID,
  FIREBASE_DATABASE_URL: `https://${EXPECTED_STAGING_PROJECT_ID}.firebaseio.com`,
  STAGING_ORIGIN: "https://family-quiz-staging.vercel.app",
  PRODUCTION_ORIGIN: "https://family-quiz.com",
  VERCEL_ALLOWED_ORIGINS: "https://family-quiz-staging.vercel.app",
  GOOGLE_CLOUD_PROJECT: EXPECTED_STAGING_PROJECT_ID,
  GCP_PROJECT_NUMBER: EXPECTED_GCP_PROJECT_NUMBER,
  GCP_WORKLOAD_IDENTITY_POOL_ID: EXPECTED_WIF_POOL_ID,
  GCP_WORKLOAD_IDENTITY_PROVIDER_ID: EXPECTED_WIF_PROVIDER_ID,
  GCP_SERVICE_ACCOUNT_EMAIL: EXPECTED_SERVICE_ACCOUNT_EMAIL,
  VERCEL_OIDC_ISSUER: EXPECTED_VERCEL_ISSUER,
  VERCEL_OIDC_AUDIENCE: EXPECTED_VERCEL_AUDIENCE,
  VERCEL_OIDC_SUBJECT: EXPECTED_VERCEL_SUBJECT,
};

const validated = validateStagingServerEnvironment(safeCanonicalEnvironment);
assert.equal(validated.projectId, EXPECTED_STAGING_PROJECT_ID);
assert.equal(validated.projectNumber, EXPECTED_GCP_PROJECT_NUMBER);
assert.equal(validated.providerId, EXPECTED_WIF_PROVIDER_ID);
const external = externalAccountOptions(safeCanonicalEnvironment);
assert.equal(
  external.audience,
  `//iam.googleapis.com/projects/${EXPECTED_GCP_PROJECT_NUMBER}/locations/global/` +
    `workloadIdentityPools/${EXPECTED_WIF_POOL_ID}/providers/${EXPECTED_WIF_PROVIDER_ID}`,
);
assert.equal(Object.hasOwn(external, "credential_source"), false);
assert.equal(Object.hasOwn(safeCanonicalEnvironment, "GOOGLE_APPLICATION_CREDENTIALS"), false);
assert.equal(Object.hasOwn(safeCanonicalEnvironment, "FIREBASE_ADMIN_PRIVATE_KEY"), false);
const vercelConfiguration = JSON.parse(
  await readFile(new URL("../vercel.json", import.meta.url), "utf8"),
);
assert.equal(vercelConfiguration.functions?.["api/*.js"]?.maxDuration, 60);
console.log("Staging environment and keyless WIF contract validation passed (no credentials used)");
