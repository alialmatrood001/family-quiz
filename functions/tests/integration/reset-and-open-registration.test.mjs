import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import {
  createEmulatorIdentity,
  db,
  deleteEmulatorIdentity,
  deleteRoom,
  roomRef,
  signInEmulatorIdentity,
} from "../helpers/emulator.mjs";
import { invokeApi } from "../helpers/local-vercel-api.mjs";

const require = createRequire(import.meta.url);
const { createServerOperations } = require("../../server/operations.js");
const { runWithVercelOidcRequest } = require("../../server/vercel-oidc.js");
const {
  closeWarmWifFirestore,
  getRequestFirestore,
  runWithWifFirestoreRequest,
} = require("../../server/wif-firestore.js");
const {
  EXPECTED_VERCEL_AUDIENCE,
  EXPECTED_VERCEL_ISSUER,
  EXPECTED_VERCEL_SUBJECT,
} = require("../../server/environment-guard.js");

const COLLECTIONS = [
  "players",
  "playerPrivate",
  "playerRegistrationKeys",
  "visitors",
  "answers",
  "questionResults",
  "messages",
];

async function seedResetRoom(roomId, stage) {
  const ref = roomRef(roomId);
  await ref.set({
    stage,
    activeQuestionId: "question-1",
    processedQuestionId: "question-1",
    finalization: { status: "completed", questionId: "question-1" },
  });
  for (const name of COLLECTIONS) {
    await ref.collection(name).doc(`${name}-document`).set({ safeTestValue: true });
  }
}

async function assertResetState(roomId) {
  const ref = roomRef(roomId);
  const snapshot = await ref.get();
  assert.equal(snapshot.data().stage, "registration");
  assert.equal(snapshot.data().activeQuestionId, null);
  assert.equal(snapshot.data().processedQuestionId, null);
  for (const name of COLLECTIONS) {
    assert.equal((await ref.collection(name).get()).empty, true, `${name} should be empty`);
  }
}

function stagingEnvironment() {
  return {
    APP_ENVIRONMENT: "staging",
    SERVER_TRANSPORT: "vercel",
    VERCEL_ENV: "production",
    FIREBASE_ADMIN_AUTH_MODE: "oidc",
    FIREBASE_ADMIN_PROJECT_ID: "family-quiz-staging",
    FIREBASE_PRODUCTION_PROJECT_ID: "family-quiz-b7960",
    CONFIRM_STAGING_PROJECT: "family-quiz-staging",
    FIREBASE_DATABASE_URL: "https://family-quiz-staging-default-rtdb.firebaseio.com",
    STAGING_ORIGIN: "https://family-quiz-staging.vercel.app",
    VERCEL_ALLOWED_ORIGINS: "https://family-quiz-staging.vercel.app",
    PRODUCTION_ORIGIN: "https://family-quiz-psi.vercel.app",
    GOOGLE_CLOUD_PROJECT: "family-quiz-staging",
    GCP_PROJECT_NUMBER: "110839511131",
    GCP_WORKLOAD_IDENTITY_POOL_ID: "vercel-staging",
    GCP_WORKLOAD_IDENTITY_PROVIDER_ID: "vercel-staging",
    GCP_SERVICE_ACCOUNT_EMAIL: "vercel-staging-firebase-admin@family-quiz-staging.iam.gserviceaccount.com",
    VERCEL_OIDC_ISSUER: EXPECTED_VERCEL_ISSUER,
    VERCEL_OIDC_AUDIENCE: EXPECTED_VERCEL_AUDIENCE,
    VERCEL_OIDC_SUBJECT: EXPECTED_VERCEL_SUBJECT,
  };
}

function oidcToken(marker) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: EXPECTED_VERCEL_ISSUER,
    aud: EXPECTED_VERCEL_AUDIENCE,
    sub: EXPECTED_VERCEL_SUBJECT,
    iat: now - 30,
    exp: now + 600,
  })).toString("base64url");
  return `${header}.${payload}.${marker}`;
}

class EmulatorFirestore {
  constructor(settings) { this.settings = settings; }
  doc(...args) { return db.doc(...args); }
  batch(...args) { return db.batch(...args); }
  runTransaction(...args) { return db.runTransaction(...args); }
  async terminate() {}
}

class EmulatorGoogleAuth {
  async getClient() {
    return { getAccessToken: async () => ({ token: "local-emulator-access-token" }) };
  }
}

test("resetAndOpenRegistration is safe from prizeWheel, finished, and on retry", { timeout: 90_000 }, async (t) => {
  const identity = await createEmulatorIdentity({ admin: true, label: "reset-admin" });
  const token = await signInEmulatorIdentity(identity);
  const roomIds = ["reset-from-prize-wheel", "reset-from-finished"];
  t.after(async () => {
    await Promise.all(roomIds.map(deleteRoom));
    await deleteEmulatorIdentity(identity.uid);
  });

  for (const [roomId, stage] of [[roomIds[0], "prizeWheel"], [roomIds[1], "finished"]]) {
    await seedResetRoom(roomId, stage);
    const response = await invokeApi("admin", {
      token,
      action: "resetAndOpenRegistration",
      data: { roomId },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.data.status, "registration-opened");
    await assertResetState(roomId);

    const retry = await invokeApi("admin", {
      token,
      action: "resetAndOpenRegistration",
      data: { roomId },
    });
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.body.data.status, "registration-opened");
    assert.equal(retry.body.data.reset.deletedCount, 0);
    await assertResetState(roomId);
  }
});

test("warm WIF survives reset between sequential and concurrent request contexts", { timeout: 90_000 }, async (t) => {
  const runtimeCache = { runtime: null, closing: null };
  const roomIds = Array.from({ length: 5 }, (_, index) => `warm-reset-${index}`);
  t.after(async () => {
    await Promise.all(roomIds.map(deleteRoom));
    await closeWarmWifFirestore(runtimeCache);
  });
  await Promise.all(roomIds.map((roomId, index) => seedResetRoom(
    roomId,
    index % 2 === 0 ? "prizeWheel" : "finished",
  )));

  const run = (roomId, marker) => runWithVercelOidcRequest(
    { headers: { "x-vercel-oidc-token": oidcToken(marker) } },
    () => runWithWifFirestoreRequest(
      stagingEnvironment(),
      async () => {
        const requestDb = getRequestFirestore();
        const operations = createServerOperations({ db: requestDb });
        const auth = { uid: `admin-${marker}`, token: { admin: true } };
        return operations.resetAndOpenRegistration({ auth, data: { roomId } });
      },
      {
        FirestoreClass: EmulatorFirestore,
        GoogleAuthClass: EmulatorGoogleAuth,
        runtimeCache,
      },
    ),
  );

  for (let index = 0; index < roomIds.length; index += 1) {
    assert.equal((await run(roomIds[index], `sequential-${index}`)).status, "registration-opened");
  }
  await Promise.all(roomIds.map((roomId, index) => run(roomId, `concurrent-${index}`)));
  for (const roomId of roomIds) await assertResetState(roomId);
});
