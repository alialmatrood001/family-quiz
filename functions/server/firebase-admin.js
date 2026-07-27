"use strict";

const { applicationDefault, cert, getApp, getApps, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getDatabase } = require("firebase-admin/database");
const { getFirestore } = require("firebase-admin/firestore");
const { validateStagingServerEnvironment } = require("./environment-guard");

const DEMO_PROJECT_ID = "demo-family-quiz";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function localHostname(value) {
  return String(value || "")
    .replace(/^https?:\/\//, "")
    .replace(/^\[/, "")
    .split(/[:\]]/)[0];
}

function assertLocalEmulator(name) {
  const value = process.env[name];
  if (!value || !LOCAL_HOSTS.has(localHostname(value))) {
    throw new Error(`${name} must point to localhost in emulator mode`);
  }
}

function emulatorConfiguration() {
  const names = [
    "FIRESTORE_EMULATOR_HOST",
    "FIREBASE_AUTH_EMULATOR_HOST",
    "FIREBASE_DATABASE_EMULATOR_HOST",
  ];
  const enabled = names.some((name) => Boolean(process.env[name]));
  if (!enabled) return null;
  names.forEach(assertLocalEmulator);
  if (
    process.env.GOOGLE_APPLICATION_CREDENTIALS &&
    process.env.FUNCTIONS_EMULATOR !== "true"
  ) {
    throw new Error("Service-account credentials are forbidden in emulator mode");
  }
  const projectId =
    process.env.GCLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.FIREBASE_ADMIN_PROJECT_ID ||
    DEMO_PROJECT_ID;
  if (projectId !== DEMO_PROJECT_ID) {
    throw new Error(`Emulator mode is restricted to ${DEMO_PROJECT_ID}`);
  }
  return { projectId, mode: "emulator" };
}

function productionConfiguration() {
  const projectId =
    process.env.FIREBASE_ADMIN_PROJECT_ID ||
    process.env.GCLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT;
  const managedFirebaseRuntime =
    Boolean(
      process.env.FIREBASE_CONFIG ||
        process.env.K_SERVICE ||
        process.env.FUNCTION_TARGET
    ) &&
    Boolean(process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT);

  if (managedFirebaseRuntime) {
    return {
      projectId,
      credential: applicationDefault(),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
      mode: "firebase-managed",
    };
  }

  const deploymentEnvironment = String(process.env.APP_ENVIRONMENT || "").trim();
  if (deploymentEnvironment !== "staging") {
    throw new Error(
      "Vercel Firebase Admin requires APP_ENVIRONMENT=staging; production is not configured here"
    );
  }
  validateStagingServerEnvironment(process.env);
  const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY;
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
    databaseURL: process.env.FIREBASE_DATABASE_URL,
    mode: "vercel",
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
  getServerFirebase,
};
