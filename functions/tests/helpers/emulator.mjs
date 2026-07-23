import assert from "node:assert/strict";
import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

export const DEMO_PROJECT_ID = "demo-family-quiz";
export const FUNCTION_REGION = "us-central1";
export const FUNCTION_NAME = "finalizeQuestion";

const requiredHosts = [
  "FIRESTORE_EMULATOR_HOST",
  "FIREBASE_AUTH_EMULATOR_HOST",
  "FIREBASE_DATABASE_EMULATOR_HOST",
];

function isLocalHost(value) {
  if (!value) return false;
  const hostname = String(value).replace(/^https?:\/\//, "").split(":")[0];
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

export function assertEmulatorSafety() {
  for (const name of requiredHosts) {
    assert.ok(process.env[name], `${name} is required; refusing to run outside Firebase Emulator Suite`);
    assert.ok(isLocalHost(process.env[name]), `${name} must point to localhost; received a non-local host`);
  }

  if (process.env.FIREBASE_EMULATOR_HUB) {
    assert.ok(isLocalHost(process.env.FIREBASE_EMULATOR_HUB), "FIREBASE_EMULATOR_HUB must be local");
  }

  assert.equal(
    process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || DEMO_PROJECT_ID,
    DEMO_PROJECT_ID,
    "Tests may run only against the demo-family-quiz project namespace"
  );
  assert.ok(
    process.env.FUNCTIONS_EMULATOR === "true" ||
      isLocalHost(process.env.FIREBASE_EMULATOR_HUB) ||
      (process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT) === DEMO_PROJECT_ID,
    "Functions Emulator signal is missing; refusing to invoke finalizeQuestion"
  );
  assert.equal(
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    undefined,
    "Service-account credentials are forbidden in baseline emulator tests"
  );
}

assertEmulatorSafety();

const app = getApps()[0] || initializeApp({ projectId: DEMO_PROJECT_ID });
export const db = getFirestore(app);
const auth = getAuth(app);
const tokenCache = new Map();

export function roomRef(roomId) {
  return db.doc(`rooms/${roomId}`);
}

export async function deleteRoom(roomId) {
  const ref = roomRef(roomId);
  for (const collectionName of ["answers", "players", "questions", "messages", "questionResults"]) {
    const snapshot = await ref.collection(collectionName).get();
    for (let offset = 0; offset < snapshot.docs.length; offset += 400) {
      const batch = db.batch();
      snapshot.docs.slice(offset, offset + 400).forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
    }
  }
  await ref.delete();
}

export async function writeScenario(scenario) {
  await deleteRoom(scenario.roomId);
  const ref = roomRef(scenario.roomId);
  const writeDocuments = async (writes) => {
    for (let offset = 0; offset < writes.length; offset += 400) {
      const batch = db.batch();
      writes.slice(offset, offset + 400).forEach(([documentRef, data]) => batch.set(documentRef, data));
      await batch.commit();
    }
  };

  const roomStartedAt = performance.now();
  await ref.set(scenario.room);
  const roomMs = performance.now() - roomStartedAt;

  const playersStartedAt = performance.now();
  await writeDocuments(
    scenario.players.map((player) => {
      const data = { ...player };
      if (Number.isFinite(data.jokerLockedAtMs)) {
        data.jokerLockedAt = Timestamp.fromMillis(data.jokerLockedAtMs);
        delete data.jokerLockedAtMs;
      }
      return [ref.collection("players").doc(player.id), data];
    })
  );
  const playersMs = performance.now() - playersStartedAt;

  const answersStartedAt = performance.now();
  await writeDocuments(
    scenario.answers.map((answer) => {
      const data = { ...answer };
      if (Number.isFinite(data.createdAtMs)) {
        data.createdAt = Timestamp.fromMillis(data.createdAtMs);
        delete data.createdAtMs;
      }
      return [ref.collection("answers").doc(answer.id), data];
    })
  );
  const answersMs = performance.now() - answersStartedAt;

  return { roomMs, playersMs, answersMs };
}

export async function readState(roomId) {
  const ref = roomRef(roomId);
  const [roomSnapshot, playersSnapshot, answersSnapshot, resultsSnapshot] = await Promise.all([
    ref.get(),
    ref.collection("players").get(),
    ref.collection("answers").get(),
    ref.collection("questionResults").get(),
  ]);
  return {
    roomExists: roomSnapshot.exists,
    room: roomSnapshot.exists ? roomSnapshot.data() : null,
    players: playersSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
    answers: answersSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
    results: resultsSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
  };
}

async function authToken(role) {
  if (tokenCache.has(role)) return tokenCache.get(role);
  const email = `operation4-${role}@example.test`;
  const emulatorPassphrase = "LocalEmulatorOnly-42!";
  let user;
  try {
    user = await auth.getUserByEmail(email);
  } catch {
    user = await auth.createUser({
      email,
      password: emulatorPassphrase,
      displayName: `Operation 4 ${role}`,
    });
  }
  await auth.setCustomUserClaims(user.uid, role === "admin" ? { admin: true } : {});
  const response = await fetch(
    "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password: emulatorPassphrase,
        returnSecureToken: true,
      }),
    }
  );
  const body = await response.json();
  assert.ok(response.ok && body.idToken, `Authentication Emulator sign-in failed for ${role}`);
  tokenCache.set(role, body.idToken);
  return body.idToken;
}

export async function callFinalizeQuestion(
  data,
  { authRole = "admin", timeoutMs = 20_000 } = {}
) {
  assertEmulatorSafety();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url =
    `http://127.0.0.1:5001/${DEMO_PROJECT_ID}/${FUNCTION_REGION}/${FUNCTION_NAME}`;
  const headers = { "content-type": "application/json" };
  if (authRole !== "none") {
    headers.authorization = `Bearer ${await authToken(authRole)}`;
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ data }),
      signal: controller.signal,
    });
    const body = await response.json();
    if (!response.ok || body.error) {
      const error = new Error(body.error?.message || `Callable failed with HTTP ${response.status}`);
      error.status = response.status;
      error.body = body;
      error.code = body.error?.status || null;
      throw error;
    }
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

export function playerMap(players) {
  return new Map(players.map((player) => [player.id, player]));
}

export function emitMetric(name, value, unit = "ms") {
  console.log(`BASELINE_METRIC ${JSON.stringify({ name, value: Math.round(value * 100) / 100, unit })}`);
}
