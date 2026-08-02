"use strict";

const PLACEHOLDER_PATTERN = /(replace|placeholder|example|current_existing)/i;
const EXPECTED_STAGING_PROJECT_ID = "family-quiz-staging";
const EXPECTED_PRODUCTION_PROJECT_ID = "family-quiz-b7960";
const EXPECTED_GCP_PROJECT_NUMBER = "110839511131";
const EXPECTED_WIF_POOL_ID = "vercel-staging";
const EXPECTED_WIF_PROVIDER_ID = "vercel-staging";
const EXPECTED_SERVICE_ACCOUNT_EMAIL =
  "vercel-staging-firebase-admin@family-quiz-staging.iam.gserviceaccount.com";
const EXPECTED_VERCEL_ISSUER =
  "https://oidc.vercel.com/ali-almatrood-s-projects";
const EXPECTED_VERCEL_AUDIENCE =
  "https://vercel.com/ali-almatrood-s-projects";
const EXPECTED_VERCEL_SUBJECT =
  "owner:ali-almatrood-s-projects:project:family-quiz-staging:environment:production";

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function required(env, name) {
  const value = String(env[name] || "").trim();
  if (!value || PLACEHOLDER_PATTERN.test(value)) {
    throw new Error(`Staging configuration requires ${name}`);
  }
  return value;
}

function assertHttpsOrigin(value, name) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTPS origin`);
  }
  if (parsed.protocol !== "https:" || parsed.origin !== value || value.includes("*")) {
    throw new Error(`${name} must be an exact HTTPS origin without wildcards or paths`);
  }
  return value;
}

function validateStagingServerEnvironment(env = process.env) {
  if (String(env.APP_ENVIRONMENT || "").trim() !== "staging") {
    throw new Error("APP_ENVIRONMENT must be staging");
  }
  if (String(env.SERVER_TRANSPORT || "").trim() !== "vercel") {
    throw new Error("SERVER_TRANSPORT must be vercel in staging");
  }
  if (String(env.VERCEL_ENV || "").trim() !== "production") {
    throw new Error(
      "VERCEL_ENV must be production for the isolated Vercel staging project",
    );
  }
  if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error("Service-account files are forbidden in Vercel staging");
  }

  const projectId = required(env, "FIREBASE_ADMIN_PROJECT_ID");
  const confirmation = required(env, "CONFIRM_STAGING_PROJECT");
  const productionProjectId = required(env, "FIREBASE_PRODUCTION_PROJECT_ID");
  if (projectId !== EXPECTED_STAGING_PROJECT_ID) {
    throw new Error(`Staging project must be ${EXPECTED_STAGING_PROJECT_ID}`);
  }
  if (productionProjectId !== EXPECTED_PRODUCTION_PROJECT_ID) {
    throw new Error("The known production project guard is invalid");
  }
  if (confirmation !== projectId) {
    throw new Error("CONFIRM_STAGING_PROJECT must exactly match FIREBASE_ADMIN_PROJECT_ID");
  }
  if (projectId === productionProjectId) {
    throw new Error("Staging Firebase project must not equal the production project");
  }
  const allowlist = splitList(env.STAGING_PROJECT_ALLOWLIST);
  if (!projectId.toLowerCase().includes("staging") && !allowlist.includes(projectId)) {
    throw new Error("Staging project must contain staging or be explicitly allowlisted");
  }

  const databaseURL = required(env, "FIREBASE_DATABASE_URL");
  const databaseHost = new URL(databaseURL).hostname;
  const knownDatabaseHost =
    databaseHost === `${projectId}.firebaseio.com` ||
    databaseHost === `${projectId}-default-rtdb.firebaseio.com` ||
    databaseHost === `${projectId}-default-rtdb.firebasedatabase.app` ||
    databaseHost === `${projectId}-default-rtdb.us-central1.firebasedatabase.app`;
  if (!knownDatabaseHost) {
    throw new Error("Realtime Database URL does not belong to the staging project");
  }

  const stagingOrigin = assertHttpsOrigin(required(env, "STAGING_ORIGIN"), "STAGING_ORIGIN");
  const productionOrigin = assertHttpsOrigin(
    required(env, "PRODUCTION_ORIGIN"),
    "PRODUCTION_ORIGIN",
  );
  if (stagingOrigin === productionOrigin) {
    throw new Error("Staging and production origins must be different");
  }
  const configuredOrigins = splitList(env.VERCEL_ALLOWED_ORIGINS);
  if (
    configuredOrigins.length !== 1 ||
    configuredOrigins[0] !== stagingOrigin ||
    configuredOrigins.includes(productionOrigin)
  ) {
    throw new Error("VERCEL_ALLOWED_ORIGINS must contain only STAGING_ORIGIN");
  }

  const authMode = required(env, "FIREBASE_ADMIN_AUTH_MODE");
  if (!["oidc", "legacy-key"].includes(authMode)) {
    throw new Error("FIREBASE_ADMIN_AUTH_MODE must be oidc or legacy-key");
  }
  const hasLegacyCredential =
    Boolean(env.FIREBASE_ADMIN_CLIENT_EMAIL) ||
    Boolean(env.FIREBASE_ADMIN_PRIVATE_KEY);
  const hasOidcConfiguration = [
    "GCP_PROJECT_NUMBER",
    "GCP_WORKLOAD_IDENTITY_POOL_ID",
    "GCP_WORKLOAD_IDENTITY_PROVIDER_ID",
    "GCP_SERVICE_ACCOUNT_EMAIL",
    "VERCEL_OIDC_ISSUER",
    "VERCEL_OIDC_AUDIENCE",
    "VERCEL_OIDC_SUBJECT",
  ].some((name) => Boolean(env[name]));
  if (hasLegacyCredential && hasOidcConfiguration) {
    throw new Error("OIDC and legacy Firebase Admin credentials cannot be configured together");
  }

  if (authMode === "legacy-key") {
    const clientEmail = required(env, "FIREBASE_ADMIN_CLIENT_EMAIL");
    const privateKey = required(env, "FIREBASE_ADMIN_PRIVATE_KEY");
    if (!clientEmail.endsWith(`@${projectId}.iam.gserviceaccount.com`)) {
      throw new Error("Firebase Admin client email does not belong to the staging project");
    }
    if (!privateKey.includes("BEGIN PRIVATE KEY")) {
      throw new Error("Firebase Admin private key format is invalid");
    }
  } else {
    if (hasLegacyCredential) {
      throw new Error("Private-key credentials are forbidden in OIDC mode");
    }
    const googleProject = required(env, "GOOGLE_CLOUD_PROJECT");
    if (googleProject !== EXPECTED_STAGING_PROJECT_ID) {
      throw new Error("GOOGLE_CLOUD_PROJECT must target the staging project");
    }
    const projectNumber = required(env, "GCP_PROJECT_NUMBER");
    if (projectNumber !== EXPECTED_GCP_PROJECT_NUMBER) {
      throw new Error("GCP_PROJECT_NUMBER does not match the staging project");
    }
    const poolId = required(env, "GCP_WORKLOAD_IDENTITY_POOL_ID");
    if (poolId !== EXPECTED_WIF_POOL_ID) {
      throw new Error("GCP_WORKLOAD_IDENTITY_POOL_ID does not match staging");
    }
    const providerId = required(env, "GCP_WORKLOAD_IDENTITY_PROVIDER_ID");
    if (providerId !== EXPECTED_WIF_PROVIDER_ID) {
      throw new Error("GCP_WORKLOAD_IDENTITY_PROVIDER_ID does not match staging");
    }
    const serviceAccountEmail = required(env, "GCP_SERVICE_ACCOUNT_EMAIL");
    if (serviceAccountEmail !== EXPECTED_SERVICE_ACCOUNT_EMAIL) {
      throw new Error("GCP_SERVICE_ACCOUNT_EMAIL does not match the staging service account");
    }
    const oidcClaims = {
      VERCEL_OIDC_ISSUER: EXPECTED_VERCEL_ISSUER,
      VERCEL_OIDC_AUDIENCE: EXPECTED_VERCEL_AUDIENCE,
      VERCEL_OIDC_SUBJECT: EXPECTED_VERCEL_SUBJECT,
    };
    for (const [name, expected] of Object.entries(oidcClaims)) {
      const value = required(env, name);
      if (value.includes("*") || value !== expected) {
        throw new Error(`${name} does not match the approved Vercel staging identity`);
      }
    }
  }

  return Object.freeze({
    environment: "staging",
    transport: "vercel",
    projectId,
    projectNumber: String(env.GCP_PROJECT_NUMBER || "").trim() || null,
    poolId: String(env.GCP_WORKLOAD_IDENTITY_POOL_ID || "").trim() || null,
    providerId: String(env.GCP_WORKLOAD_IDENTITY_PROVIDER_ID || "").trim() || null,
    serviceAccountEmail: String(env.GCP_SERVICE_ACCOUNT_EMAIL || "").trim() || null,
    databaseURL,
    stagingOrigin,
    authMode,
  });
}

module.exports = {
  EXPECTED_PRODUCTION_PROJECT_ID,
  EXPECTED_GCP_PROJECT_NUMBER,
  EXPECTED_SERVICE_ACCOUNT_EMAIL,
  EXPECTED_STAGING_PROJECT_ID,
  EXPECTED_VERCEL_AUDIENCE,
  EXPECTED_VERCEL_ISSUER,
  EXPECTED_VERCEL_SUBJECT,
  EXPECTED_WIF_POOL_ID,
  EXPECTED_WIF_PROVIDER_ID,
  validateStagingServerEnvironment,
};
