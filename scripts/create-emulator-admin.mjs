import assert from "node:assert/strict";
import { createRequire } from "node:module";

const requireFromFunctions = createRequire(
  new URL("../functions/package.json", import.meta.url),
);
const { deleteApp, getApps, initializeApp } = requireFromFunctions("firebase-admin/app");
const { getAuth } = requireFromFunctions("firebase-admin/auth");

const emulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
assert.ok(
  emulatorHost === "127.0.0.1:9099" || emulatorHost === "localhost:9099",
  "FIREBASE_AUTH_EMULATOR_HOST must point to localhost:9099.",
);

const email = String(process.env.ADMIN_EMAIL || "").trim();
const password = String(process.env.ADMIN_PASSWORD || "");
assert.ok(email, "Set ADMIN_EMAIL for the local emulator account.");
assert.ok(password.length >= 8, "Set ADMIN_PASSWORD to a local value with at least 8 characters.");

const projectId = String(process.env.FIREBASE_PROJECT_ID || "demo-family-quiz");
const app = getApps()[0] || initializeApp({ projectId });
const auth = getAuth(app);
let user;
try {
  user = await auth.getUserByEmail(email);
  await auth.updateUser(user.uid, { password });
} catch (error) {
  if (error?.code !== "auth/user-not-found") throw error;
  user = await auth.createUser({ email, password, displayName: "Local Admin" });
}
await auth.setCustomUserClaims(user.uid, { admin: true });
console.log(`Local Auth Emulator admin is ready: ${email}`);
await deleteApp(app);
