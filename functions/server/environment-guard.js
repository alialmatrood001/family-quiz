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

const SENSITIVE_VARIABLES = new Set([
  "FIREBASE_ADMIN_PRIVATE_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
]);

function normalized(value) {
  return String(value ?? "").trim();
}

function safeActualValue(name, value) {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  const text = normalized(value);
  if (!text) return "empty";
  if (SENSITIVE_VARIABLES.has(name)) return "present";
  return text;
}

function guardFailure({
  message,
  failedCheck,
  configurationVariable,
  expectedValue,
  actualValue,
}) {
  const error = new Error(message);
  error.diagnosticStage = "environment-guard";
  error.failedCheck = failedCheck;
  error.configurationVariable = configurationVariable;
  error.expectedValue = expectedValue;
  error.actualValue = actualValue;
  return error;
}

function fail(env, name, failedCheck, expectedValue, message, actualValue) {
  throw guardFailure({
    message,
    failedCheck,
    configurationVariable: name,
    expectedValue,
    actualValue: actualValue ?? safeActualValue(name, env[name]),
  });
}

function splitList(value) {
  return normalized(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function required(env, name, { sensitive = false } = {}) {
  const value = normalized(env[name]);
  if (!value || PLACEHOLDER_PATTERN.test(value)) {
    fail(
      env,
      name,
      "required-variable",
      "non-empty, non-placeholder value",
      `Staging configuration requires ${name}`,
      sensitive ? (value ? "present-placeholder" : safeActualValue(name, env[name])) : undefined,
    );
  }
  return value;
}

function assertExact(env, name, expectedValue, failedCheck, message) {
  const value = normalized(env[name]);
  if (value !== expectedValue) {
    fail(env, name, failedCheck, expectedValue, message);
  }
  return value;
}

function assertAbsent(env, name, failedCheck, message) {
  if (normalized(env[name])) {
    fail(env, name, failedCheck, "absent", message);
  }
}

function assertHttpsOrigin(env, name) {
  const value = required(env, name);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(
      env,
      name,
      "https-origin",
      "exact absolute HTTPS origin without wildcard or path",
      `${name} must be an absolute HTTPS origin`,
    );
  }
  if (parsed.protocol !== "https:" || parsed.origin !== value || value.includes("*")) {
    fail(
      env,
      name,
      "https-origin",
      "exact absolute HTTPS origin without wildcard or path",
      `${name} must be an exact HTTPS origin without wildcards or paths`,
    );
  }
  return value;
}

function validateStagingServerEnvironment(env = process.env) {
  assertExact(
    env,
    "APP_ENVIRONMENT",
    "staging",
    "staging-environment",
    "APP_ENVIRONMENT must be staging",
  );
  assertExact(
    env,
    "SERVER_TRANSPORT",
    "vercel",
    "vercel-transport",
    "SERVER_TRANSPORT must be vercel in staging",
  );
  assertExact(
    env,
    "VERCEL_ENV",
    "production",
    "isolated-vercel-production-environment",
    "VERCEL_ENV must be production for the isolated Vercel staging project",
  );
  assertAbsent(
    env,
    "GOOGLE_APPLICATION_CREDENTIALS",
    "no-service-account-file",
    "Service-account files are forbidden in Vercel staging",
  );

  const projectId = required(env, "FIREBASE_ADMIN_PROJECT_ID");
  const confirmation = required(env, "CONFIRM_STAGING_PROJECT");
  const productionProjectId = required(env, "FIREBASE_PRODUCTION_PROJECT_ID");
  if (projectId !== EXPECTED_STAGING_PROJECT_ID) {
    fail(
      env,
      "FIREBASE_ADMIN_PROJECT_ID",
      "approved-staging-project",
      EXPECTED_STAGING_PROJECT_ID,
      `Staging project must be ${EXPECTED_STAGING_PROJECT_ID}`,
    );
  }
  if (productionProjectId !== EXPECTED_PRODUCTION_PROJECT_ID) {
    fail(
      env,
      "FIREBASE_PRODUCTION_PROJECT_ID",
      "known-production-project",
      EXPECTED_PRODUCTION_PROJECT_ID,
      "The known production project guard is invalid",
    );
  }
  if (confirmation !== projectId) {
    fail(
      env,
      "CONFIRM_STAGING_PROJECT",
      "confirmed-staging-project",
      projectId,
      "CONFIRM_STAGING_PROJECT must exactly match FIREBASE_ADMIN_PROJECT_ID",
    );
  }
  const databaseURL = required(env, "FIREBASE_DATABASE_URL");
  let databaseHost;
  try {
    databaseHost = new URL(databaseURL).hostname;
  } catch {
    fail(
      env,
      "FIREBASE_DATABASE_URL",
      "staging-database-url",
      "valid Realtime Database URL belonging to family-quiz-staging",
      "Realtime Database URL is invalid",
    );
  }
  const knownDatabaseHost =
    databaseHost === `${projectId}.firebaseio.com` ||
    databaseHost === `${projectId}-default-rtdb.firebaseio.com` ||
    databaseHost === `${projectId}-default-rtdb.firebasedatabase.app` ||
    databaseHost === `${projectId}-default-rtdb.us-central1.firebasedatabase.app`;
  if (!knownDatabaseHost) {
    fail(
      env,
      "FIREBASE_DATABASE_URL",
      "staging-database-host",
      `Realtime Database host belonging to ${projectId}`,
      "Realtime Database URL does not belong to the staging project",
      databaseHost,
    );
  }

  const stagingOrigin = assertHttpsOrigin(env, "STAGING_ORIGIN");
  const productionOrigin = assertHttpsOrigin(env, "PRODUCTION_ORIGIN");
  if (stagingOrigin === productionOrigin) {
    fail(
      env,
      "PRODUCTION_ORIGIN",
      "staging-production-origin-separation",
      `different from ${stagingOrigin}`,
      "Staging and production origins must be different",
    );
  }
  const configuredOrigins = splitList(env.VERCEL_ALLOWED_ORIGINS);
  if (
    configuredOrigins.length !== 1 ||
    configuredOrigins[0] !== stagingOrigin ||
    configuredOrigins.includes(productionOrigin)
  ) {
    fail(
      env,
      "VERCEL_ALLOWED_ORIGINS",
      "staging-origin-only",
      stagingOrigin,
      "VERCEL_ALLOWED_ORIGINS must contain only STAGING_ORIGIN",
      configuredOrigins.join(",") || "empty",
    );
  }

  const authMode = required(env, "FIREBASE_ADMIN_AUTH_MODE");
  if (!["oidc", "legacy-key"].includes(authMode)) {
    fail(
      env,
      "FIREBASE_ADMIN_AUTH_MODE",
      "supported-admin-auth-mode",
      "oidc or legacy-key",
      "FIREBASE_ADMIN_AUTH_MODE must be oidc or legacy-key",
    );
  }

  const oidcVariables = [
    "GCP_PROJECT_NUMBER",
    "GCP_WORKLOAD_IDENTITY_POOL_ID",
    "GCP_WORKLOAD_IDENTITY_PROVIDER_ID",
    "GCP_SERVICE_ACCOUNT_EMAIL",
    "VERCEL_OIDC_ISSUER",
    "VERCEL_OIDC_AUDIENCE",
    "VERCEL_OIDC_SUBJECT",
  ];

  if (authMode === "legacy-key") {
    for (const name of oidcVariables) {
      assertAbsent(
        env,
        name,
        "no-mixed-admin-credentials",
        "OIDC and legacy Firebase Admin credentials cannot be configured together",
      );
    }
    const clientEmail = required(env, "FIREBASE_ADMIN_CLIENT_EMAIL");
    const privateKey = required(env, "FIREBASE_ADMIN_PRIVATE_KEY", { sensitive: true });
    if (!clientEmail.endsWith(`@${projectId}.iam.gserviceaccount.com`)) {
      fail(
        env,
        "FIREBASE_ADMIN_CLIENT_EMAIL",
        "staging-service-account-domain",
        `email ending @${projectId}.iam.gserviceaccount.com`,
        "Firebase Admin client email does not belong to the staging project",
      );
    }
    if (!privateKey.includes("BEGIN PRIVATE KEY")) {
      fail(
        env,
        "FIREBASE_ADMIN_PRIVATE_KEY",
        "private-key-format",
        "valid private-key format",
        "Firebase Admin private key format is invalid",
        "present-invalid-format",
      );
    }
  } else {
    assertAbsent(
      env,
      "FIREBASE_ADMIN_CLIENT_EMAIL",
      "no-legacy-client-email-in-oidc",
      "OIDC and legacy Firebase Admin credentials cannot be configured together; private-key credentials are forbidden in OIDC mode",
    );
    assertAbsent(
      env,
      "FIREBASE_ADMIN_PRIVATE_KEY",
      "no-legacy-private-key-in-oidc",
      "OIDC and legacy Firebase Admin credentials cannot be configured together; private-key credentials are forbidden in OIDC mode",
    );
    assertExact(
      env,
      "GOOGLE_CLOUD_PROJECT",
      EXPECTED_STAGING_PROJECT_ID,
      "oidc-google-project",
      "GOOGLE_CLOUD_PROJECT must target the staging project",
    );
    const projectNumber = assertExact(
      env,
      "GCP_PROJECT_NUMBER",
      EXPECTED_GCP_PROJECT_NUMBER,
      "oidc-project-number",
      "GCP_PROJECT_NUMBER does not match the staging project",
    );
    const poolId = assertExact(
      env,
      "GCP_WORKLOAD_IDENTITY_POOL_ID",
      EXPECTED_WIF_POOL_ID,
      "oidc-pool-id",
      "GCP_WORKLOAD_IDENTITY_POOL_ID does not match staging",
    );
    const providerId = assertExact(
      env,
      "GCP_WORKLOAD_IDENTITY_PROVIDER_ID",
      EXPECTED_WIF_PROVIDER_ID,
      "oidc-provider-id",
      "GCP_WORKLOAD_IDENTITY_PROVIDER_ID does not match staging",
    );
    const serviceAccountEmail = assertExact(
      env,
      "GCP_SERVICE_ACCOUNT_EMAIL",
      EXPECTED_SERVICE_ACCOUNT_EMAIL,
      "oidc-service-account",
      "GCP_SERVICE_ACCOUNT_EMAIL does not match the staging service account",
    );
    const oidcClaims = {
      VERCEL_OIDC_ISSUER: EXPECTED_VERCEL_ISSUER,
      VERCEL_OIDC_AUDIENCE: EXPECTED_VERCEL_AUDIENCE,
      VERCEL_OIDC_SUBJECT: EXPECTED_VERCEL_SUBJECT,
    };
    for (const [name, expected] of Object.entries(oidcClaims)) {
      const value = required(env, name);
      if (value.includes("*") || value !== expected) {
        fail(
          env,
          name,
          "approved-vercel-oidc-identity",
          expected,
          `${name} does not match the approved Vercel staging identity`,
        );
      }
    }

    return Object.freeze({
      environment: "staging",
      transport: "vercel",
      projectId,
      projectNumber,
      poolId,
      providerId,
      serviceAccountEmail,
      databaseURL,
      stagingOrigin,
      authMode,
    });
  }

  return Object.freeze({
    environment: "staging",
    transport: "vercel",
    projectId,
    projectNumber: null,
    poolId: null,
    providerId: null,
    serviceAccountEmail: null,
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
