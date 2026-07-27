"use strict";

const PLACEHOLDER_PATTERN = /(replace|placeholder|example|current_existing)/i;

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
  if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error("Service-account files are forbidden in Vercel staging");
  }

  const projectId = required(env, "FIREBASE_ADMIN_PROJECT_ID");
  const confirmation = required(env, "CONFIRM_STAGING_PROJECT");
  const productionProjectId = required(env, "FIREBASE_PRODUCTION_PROJECT_ID");
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

  const clientEmail = required(env, "FIREBASE_ADMIN_CLIENT_EMAIL");
  const privateKey = required(env, "FIREBASE_ADMIN_PRIVATE_KEY");
  const databaseURL = required(env, "FIREBASE_DATABASE_URL");
  if (!clientEmail.endsWith(`@${projectId}.iam.gserviceaccount.com`)) {
    throw new Error("Firebase Admin client email does not belong to the staging project");
  }
  if (!privateKey.includes("BEGIN PRIVATE KEY")) {
    throw new Error("Firebase Admin private key format is invalid");
  }
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

  return Object.freeze({
    environment: "staging",
    transport: "vercel",
    projectId,
    stagingOrigin,
  });
}

module.exports = {
  validateStagingServerEnvironment,
};
