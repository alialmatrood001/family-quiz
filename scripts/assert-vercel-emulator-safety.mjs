import assert from "node:assert/strict";

const DEMO_PROJECT_ID = "demo-family-quiz";
const requiredHosts = [
  "FIRESTORE_EMULATOR_HOST",
  "FIREBASE_AUTH_EMULATOR_HOST",
  "FIREBASE_DATABASE_EMULATOR_HOST",
];

function isLocal(value) {
  const hostname = String(value || "")
    .replace(/^https?:\/\//, "")
    .replace(/^\[/, "")
    .split(/[:\]]/)[0];
  return ["127.0.0.1", "localhost", "::1"].includes(hostname);
}

for (const name of requiredHosts) {
  assert.ok(process.env[name], `${name} is required`);
  assert.ok(isLocal(process.env[name]), `${name} must point to localhost`);
}

assert.equal(
  process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT,
  DEMO_PROJECT_ID,
  `Only ${DEMO_PROJECT_ID} is allowed`
);
assert.equal(
  process.env.GOOGLE_APPLICATION_CREDENTIALS,
  undefined,
  "Service-account credentials are forbidden"
);
assert.equal(
  process.env.FIREBASE_ADMIN_PRIVATE_KEY,
  undefined,
  "Production Firebase Admin secrets are forbidden in emulator checks"
);

console.log("Vercel API emulator safety check passed");
