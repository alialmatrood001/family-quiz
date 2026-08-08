import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const { getServerFirebase } = require("../../functions/server/firebase-admin.js");
const { getServerOperations } = require("../../functions/server/operations.js");
const {
  runWithVercelOidcRequest,
} = require("../../functions/server/vercel-oidc.js");
const {
  ensureRequestWifCredential,
  runWithWifFirestoreRequest,
} = require("../../functions/server/wif-firestore.js");

export function serverRuntime() {
  const firebase = getServerFirebase();
  return {
    ...firebase,
    operations: getServerOperations(),
  };
}

export function withServerRequestIdentity(req, callback) {
  const emulatorMode = Boolean(
    process.env.FIRESTORE_EMULATOR_HOST ||
      process.env.FIREBASE_AUTH_EMULATOR_HOST ||
      process.env.FIREBASE_DATABASE_EMULATOR_HOST,
  );
  if (
    !emulatorMode &&
    process.env.APP_ENVIRONMENT === "staging" &&
    process.env.FIREBASE_ADMIN_AUTH_MODE === "oidc"
  ) {
    return runWithVercelOidcRequest(req, () =>
      runWithWifFirestoreRequest(process.env, callback),
    );
  }
  return callback();
}

export function ensureServerRequestDatabase() {
  const emulatorMode = Boolean(
    process.env.FIRESTORE_EMULATOR_HOST ||
      process.env.FIREBASE_AUTH_EMULATOR_HOST ||
      process.env.FIREBASE_DATABASE_EMULATOR_HOST,
  );
  if (
    !emulatorMode &&
    process.env.APP_ENVIRONMENT === "staging" &&
    process.env.FIREBASE_ADMIN_AUTH_MODE === "oidc"
  ) {
    return ensureRequestWifCredential();
  }
  return undefined;
}
