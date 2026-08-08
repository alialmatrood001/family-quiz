import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { verifiedAuth } from "../../../api/_lib/http.js";
import { SERVER_OPERATIONS } from "../../../src/server-api-core.js";
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
const {
  EXPECTED_VERCEL_AUDIENCE,
  EXPECTED_VERCEL_ISSUER,
  EXPECTED_VERCEL_SUBJECT,
} = require("../../server/environment-guard.js");
const { runWithVercelOidcRequest } = require("../../server/vercel-oidc.js");
const {
  getRequestFirestore,
  runWithWifFirestoreRequest,
} = require("../../server/wif-firestore.js");

async function call(operation, data, token) {
  const response = await invokeApi(SERVER_OPERATIONS[operation].endpoint, {
    token,
    action: operation,
    data,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const error = new Error(response.body?.error?.message || "Smoke request failed");
    error.code = response.body?.error?.code;
    error.status = response.statusCode;
    throw error;
  }
  return response.body.data;
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
    FIREBASE_DATABASE_URL:
      "https://family-quiz-staging-default-rtdb.firebaseio.com",
    STAGING_ORIGIN: "https://family-quiz-staging.vercel.app",
    VERCEL_ALLOWED_ORIGINS: "https://family-quiz-staging.vercel.app",
    PRODUCTION_ORIGIN: "https://family-quiz-psi.vercel.app",
    GOOGLE_CLOUD_PROJECT: "family-quiz-staging",
    GCP_PROJECT_NUMBER: "110839511131",
    GCP_WORKLOAD_IDENTITY_POOL_ID: "vercel-staging",
    GCP_WORKLOAD_IDENTITY_PROVIDER_ID: "vercel-staging",
    GCP_SERVICE_ACCOUNT_EMAIL:
      "vercel-staging-firebase-admin@family-quiz-staging.iam.gserviceaccount.com",
    VERCEL_OIDC_ISSUER: EXPECTED_VERCEL_ISSUER,
    VERCEL_OIDC_AUDIENCE: EXPECTED_VERCEL_AUDIENCE,
    VERCEL_OIDC_SUBJECT: EXPECTED_VERCEL_SUBJECT,
  };
}

function jwt(payload, signature = "test-signature") {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.${signature}`;
}

class MockedWifFirestore {
  constructor(settings) {
    this.settings = settings;
  }
  doc(...args) {
    return db.doc(...args);
  }
  runTransaction(...args) {
    return db.runTransaction(...args);
  }
  batch(...args) {
    return db.batch(...args);
  }
  bulkWriter(...args) {
    return db.bulkWriter(...args);
  }
  async terminate() {}
}

test("mocked request-local WIF completes Auth, initialize, answer, finalize, and finish", { timeout: 120_000 }, async (t) => {
  const roomId = "staging-wif-smoke";
  const questionId = "staging-wif-question";
  t.after(() => deleteRoom(roomId));
  const now = Math.floor(Date.now() / 1000);
  const adminClaims = {
    aud: "family-quiz-staging",
    iss: "https://securetoken.google.com/family-quiz-staging",
    sub: "wif-smoke-admin",
    uid: "wif-smoke-admin",
    admin: true,
    iat: now - 30,
    exp: now + 600,
  };
  const firebaseToken = jwt(adminClaims);
  const vercelToken = jwt({
    iss: EXPECTED_VERCEL_ISSUER,
    aud: EXPECTED_VERCEL_AUDIENCE,
    sub: EXPECTED_VERCEL_SUBJECT,
    iat: now - 30,
    exp: now + 600,
  }, "vercel-test-signature");
  const env = stagingEnvironment();

  await runWithVercelOidcRequest(
    { headers: { "x-vercel-oidc-token": vercelToken } },
    () => runWithWifFirestoreRequest(
      env,
      async () => {
        const requestDb = getRequestFirestore();
        assert.ok(requestDb instanceof MockedWifFirestore);
        assert.equal(requestDb.settings.projectId, "family-quiz-staging");
        const adminAuth = await verifiedAuth(
          { headers: { authorization: `Bearer ${firebaseToken}` } },
          {
            env,
            runtimeFactory: () => ({
              projectId: "family-quiz-staging",
              auth: { verifyIdToken: async () => adminClaims },
            }),
          },
        );
        assert.equal(adminAuth.token.admin, true);
        const playerAuth = { uid: "wif-smoke-player", token: { sub: "wif-smoke-player" } };
        const operations = createServerOperations({ db: requestDb });
        const admin = (action, data) => operations[action]({ auth: adminAuth, data });
        const player = (action, data) => operations[action]({ auth: playerAuth, data });

        assert.equal((await admin("initializeQuiz", { roomId })).status, "created");
        await admin("controlQuizLifecycle", { roomId, action: "open-registration" });
        await db.doc(`rooms/${roomId}/questions/${questionId}`).set({
          text: "Mocked WIF question",
          options: ["A", "B"],
          correctIndex: 0,
          maxPoints: 1000,
          minPoints: 100,
          seconds: 30,
          answerRevealDelaySeconds: 0,
        });
        const registration = await player("registerPlayer", {
          roomId,
          name: "WIF Player",
          emoji: "W",
          fullName: "WIF Private Player",
          phone: "0500000992",
        });
        await admin("controlQuizLifecycle", { roomId, action: "start-competition" });
        await admin("prepareQuestion", { roomId, questionId, questionIndex: 0 });
        await admin("startQuestion", { roomId, questionId });
        assert.equal((await player("submitAnswer", {
          roomId,
          questionId,
          playerId: registration.playerId,
          selectedIndex: 0,
        })).status, "received");
        await admin("controlQuestion", { roomId, questionId, action: "reveal" });
        assert.equal((await admin("finalizeQuestion", { roomId, questionId })).status, "finalized");
        assert.equal((await admin("finishQuiz", { roomId })).status, "finished");
      },
      { FirestoreClass: MockedWifFirestore },
    ),
  );

  assert.equal((await roomRef(roomId).get()).data().stage, "finished");
});

test("mocked Staging release completes the admin and player contest lifecycle", { timeout: 120_000 }, async (t) => {
  const roomId = "staging-release-smoke";
  const questionId = "staging-release-question";
  const secondQuestionId = "staging-release-question-2";
  const [admin, player, nonAdmin] = await Promise.all([
    createEmulatorIdentity({ admin: true, label: "release-smoke-admin" }),
    createEmulatorIdentity({ label: "release-smoke-player" }),
    createEmulatorIdentity({ label: "release-smoke-non-admin" }),
  ]);
  const [adminToken, playerToken, nonAdminToken] = await Promise.all([
    signInEmulatorIdentity(admin),
    signInEmulatorIdentity(player),
    signInEmulatorIdentity(nonAdmin),
  ]);
  t.after(async () => {
    await deleteRoom(roomId);
    await Promise.all([admin, player, nonAdmin].map(({ uid }) => deleteEmulatorIdentity(uid)));
  });

  await assert.rejects(
    call("initializeQuiz", { roomId }, nonAdminToken),
    (error) => error.status === 403 && error.code === "permission-denied",
  );
  await assert.rejects(
    call("initializeQuiz", { roomId, uid: admin.uid }, adminToken),
    (error) => error.status === 400 && error.code === "invalid-argument",
  );

  assert.equal((await call("initializeQuiz", { roomId }, adminToken)).status, "created");
  assert.equal(
    (await call("controlQuizLifecycle", { roomId, action: "open-registration" }, adminToken)).status,
    "open-registration",
  );
  const room = roomRef(roomId);
  await room.collection("questions").doc(questionId).set({
    text: "Staging release smoke",
    options: ["A", "B"],
    correctIndex: 0,
    maxPoints: 1000,
    minPoints: 100,
    seconds: 30,
    answerRevealDelaySeconds: 0,
  });
  await room.collection("questions").doc(secondQuestionId).set({
    text: "Staging release follow-up",
    options: ["A", "B"],
    correctIndex: 1,
    maxPoints: 1000,
    minPoints: 100,
    seconds: 30,
    answerRevealDelaySeconds: 0,
  });

  const registration = await call("registerPlayer", {
    roomId,
    name: "Release Player",
    emoji: "R",
    fullName: "Release Private Name",
    phone: "0500000991",
  }, playerToken);
  assert.equal(registration.status, "registered");
  const playerId = registration.playerId;
  assert.equal((await call("recoverPlayer", { roomId }, playerToken)).playerId, playerId);
  const firstJoker = await call(
    "activateJoker",
    { roomId, questionId: "next", playerId },
    playerToken,
  );
  const repeatedJoker = await call(
    "activateJoker",
    { roomId, questionId: "next", playerId },
    playerToken,
  );
  assert.equal(firstJoker.status, "pending");
  assert.equal(repeatedJoker.status, "already-pending");

  await call("controlQuizLifecycle", { roomId, action: "start-competition" }, adminToken);
  await call("prepareQuestion", { roomId, questionId, questionIndex: 0 }, adminToken);
  await call("startQuestion", { roomId, questionId }, adminToken);
  assert.equal(
    (await call("submitAnswer", { roomId, questionId, playerId, selectedIndex: 0 }, playerToken)).status,
    "received",
  );
  await assert.rejects(
    call("submitAnswer", { roomId, questionId, playerId, selectedIndex: 1 }, playerToken),
    (error) => error.status === 409 && error.code === "already-exists",
  );
  await call("controlQuestion", { roomId, questionId, action: "reveal" }, adminToken);
  assert.equal((await call("finalizeQuestion", { roomId, questionId }, adminToken)).status, "finalized");
  assert.equal(
    (await call("finalizeQuestion", { roomId, questionId }, adminToken)).status,
    "already-finalized",
  );
  assert.equal((await call("recoverPlayer", { roomId }, playerToken)).playerId, playerId);
  await assert.rejects(
    call("recoverPlayer", { roomId }, nonAdminToken),
    (error) => error.status === 404 && error.code === "not-found",
  );
  await call("prepareQuestion", { roomId, questionId: secondQuestionId, questionIndex: 1 }, adminToken);
  await call("startQuestion", { roomId, questionId: secondQuestionId }, adminToken);
  assert.equal(
    (await call("submitAnswer", {
      roomId,
      questionId: secondQuestionId,
      playerId,
      selectedIndex: 1,
    }, playerToken)).status,
    "received",
  );
  await call(
    "controlQuestion",
    { roomId, questionId: secondQuestionId, action: "reveal" },
    adminToken,
  );
  assert.equal(
    (await call("finalizeQuestion", { roomId, questionId: secondQuestionId }, adminToken)).status,
    "finalized",
  );
  await call(
    "controlQuizLifecycle",
    { roomId, action: "begin-final-countdown" },
    adminToken,
  );
  assert.equal((await call("finishQuiz", { roomId }, adminToken)).status, "finished");
  assert.equal((await call("finishQuiz", { roomId }, adminToken)).status, "already-finished");

  const [finishedRoom, publicPlayer, privatePlayer, answers] = await Promise.all([
    room.get(),
    room.collection("players").doc(playerId).get(),
    room.collection("playerPrivate").doc(playerId).get(),
    room.collection("answers").get(),
  ]);
  assert.equal(finishedRoom.data().stage, "finished");
  assert.equal(finishedRoom.data().gameHistory.length, 1);
  assert.equal(finishedRoom.data().gameHistory[0].answers[0].isCorrect, true);
  assert.ok(finishedRoom.data().gameHistory[0].answers[0].points > 0);
  assert.deepEqual(finishedRoom.data().gameHistory[0].questions[0].options, ["A", "B"]);
  assert.equal(answers.size, 2);
  const publicText = JSON.stringify({
    player: publicPlayer.data(),
    history: finishedRoom.data().gameHistory,
  });
  for (const privateValue of ["0500000991", "Release Private Name", player.uid]) {
    assert.equal(publicText.includes(privateValue), false);
  }
  assert.equal(privatePlayer.data().authUid, player.uid);
});

test("critical Staging lifecycle functions do not perform browser-side privileged writes", async () => {
  const source = await readFile(new URL("../../../src/App.jsx", import.meta.url), "utf8");
  for (const functionName of [
    "returnToRegistrationKeepingPlayers",
    "showInstructionsPage",
    "resetAndStartRegistration",
    "beginFinalCountdown",
    "finishGame",
  ]) {
    const start = source.indexOf(`async function ${functionName}`);
    const next = source.indexOf("\nasync function ", start + 1);
    const body = source.slice(start, next === -1 ? source.length : next);
    assert.ok(start >= 0, `${functionName} must exist`);
    assert.doesNotMatch(body, /\b(setDoc|updateDoc|runTransaction|deleteDoc|addDoc)\s*\(/);
  }
});
