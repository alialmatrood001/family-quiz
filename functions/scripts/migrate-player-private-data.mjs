import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { initializeApp, getApps } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

const require = createRequire(import.meta.url);
const { migratePlayerPrivateData } = require("../player-private/migration.js");

function localHost(value) {
  const host = String(value || "").replace(/^https?:\/\//, "").split(":")[0];
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function assertMigrationSafety(projectId) {
  assert.ok(localHost(process.env.FIRESTORE_EMULATOR_HOST), "Firestore Emulator is required");
  assert.match(projectId, /^demo-[a-z0-9-]+$/, "Only demo-* project namespaces are allowed");
  assert.equal(
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    undefined,
    "Service-account credentials are forbidden"
  );
}

const roomFlagIndex = process.argv.indexOf("--room");
const roomId = roomFlagIndex >= 0 ? process.argv[roomFlagIndex + 1] : "";
const dryRun = !process.argv.includes("--apply");
const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";

assert.match(roomId, /^[A-Za-z0-9_-]{1,128}$/, "--room requires a safe room identifier");
assertMigrationSafety(projectId);

const app = getApps()[0] || initializeApp({ projectId });
const result = await migratePlayerPrivateData({
  db: getFirestore(app),
  roomId,
  dryRun,
  now: () => FieldValue.serverTimestamp(),
});
console.log(JSON.stringify({ mode: dryRun ? "dry-run" : "apply", counts: result.counts }));
