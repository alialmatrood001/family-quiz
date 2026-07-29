"use strict";

const { applicationDefault, cert, getApp, getApps, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getDatabase } = require("firebase-admin/database");
const { getFirestore } = require("firebase-admin/firestore");
const { validateStagingServerEnvironment } = require("./environment-guard");
const { getWifCredential } = require("./vercel-oidc");

const DEMO_PROJECT_ID = "demo-family-quiz";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function localHostname(value) {
  return String(value || "")
    .replace(/^https?:\/\//, "")
    .replace(/^\[/, "")
    .split(/[:\]]/)[0];
}

function assertLocalEmulator(env, name) {
  const value = env[name];
  if (!value || !LOCAL_HOSTS.has(localHostname(value))) {
    throw new Error(`${name} must point to localhost in emulator mode`);
  }
}

function emulatorConfiguration(env = process.env) {
  const names = [
    "FIRESTORE_EMULATOR_HOST",
    "FIREBASE_AUTH_EMULATOR_HOST",
    "FIREBASE_DATABASE_EMULATOR_HOST",
  ];
  const enabled = names.some((name) => Boolean(env[name]));
  if (!enabled) return null;
  names.forEach((name) => assertLocalEmulator(env, name));
  if (
    env.GOOGLE_APPLICATION_CREDENTIALS &&
    env.FUNCTIONS_EMULATOR !== "true"
  ) {
    throw new Error("Service-account credentials are forbidden in emulator mode");
  }
  const projectId =
    env.GCLOUD_PROJECT ||
    env.GOOGLE_CLOUD_PROJECT ||
    env.FIREBASE_ADMIN_PROJECT_ID ||
    DEMO_PROJECT_ID;
  if (projectId !== DEMO_PROJECT_ID) {
    throw new Error(`Emulator mode is restricted to ${DEMO_PROJECT_ID}`);
  }
  return { projectId, mode: "emulator" };
}

function productionConfiguration(
  env = process.env,
  { oidcCredentialFactory = getWifCredential } = {},
) {
  const projectId =
    env.FIREBASE_ADMIN_PROJECT_ID ||
    env.GCLOUD_PROJECT ||
    env.GOOGLE_CLOUD_PROJECT;
  const managedFirebaseRuntime =
    Boolean(
      env.FIREBASE_CONFIG ||
        env.K_SERVICE ||
        env.FUNCTION_TARGET
    ) &&
    Boolean(env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT);

  if (managedFirebaseRuntime) {
    return {
      projectId,
      credential: applicationDefault(),
      databaseURL: env.FIREBASE_DATABASE_URL,
      mode: "firebase-managed",
    };
  }

  const deploymentEnvironment = String(env.APP_ENVIRONMENT || "").trim();
  if (deploymentEnvironment !== "staging") {
    throw new Error(
      "Vercel Firebase Admin requires APP_ENVIRONMENT=staging; production is not configured here"
    );
  }
  const staging = validateStagingServerEnvironment(env);
  if (staging.authMode === "oidc") {
    return {
      projectId,
      credential: oidcCredentialFactory(env),
      databaseURL: env.FIREBASE_DATABASE_URL,
      mode: "vercel-oidc",
    };
  }
  const clientEmail = env.FIREBASE_ADMIN_CLIENT_EMAIL;
  const privateKey = env.FIREBASE_ADMIN_PRIVATE_KEY;
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Firebase Admin production configuration is incomplete; set FIREBASE_ADMIN_PROJECT_ID, FIREBASE_ADMIN_CLIENT_EMAIL, and FIREBASE_ADMIN_PRIVATE_KEY"
    );
  }
  return {
    projectId,
    credential: cert({
      projectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, "\n"),
    }),
    databaseURL: env.FIREBASE_DATABASE_URL,
    mode: "vercel-legacy-key",
  };
}

function getServerFirebase() {
  const config = emulatorConfiguration() || productionConfiguration();
  const app =
    getApps().length > 0
      ? getApp()
      : initializeApp({
          projectId: config.projectId,
          ...(config.credential ? { credential: config.credential } : {}),
          ...(config.databaseURL ? { databaseURL: config.databaseURL } : {}),
        });
  return {
    app,
    auth: getAuth(app),
    db: getFirestore(app),
    getRealtimeDatabase: () => getDatabase(app),
    mode: config.mode,
    projectId: config.projectId,
  };
}

module.exports = {
  DEMO_PROJECT_ID,
  emulatorConfiguration,
  getServerFirebase,
  productionConfiguration,
};
