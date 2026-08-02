import assert from "node:assert/strict";
import test from "node:test";
import adminHandler from "../../../api/admin.js";
import healthHandler from "../../../api/health.js";
import playerHandler from "../../../api/player.js";
import quizHandler from "../../../api/quiz.js";
import { createServerApiClient } from "../../../src/server-api-core.js";
import {
  createEmulatorIdentity,
  deleteEmulatorIdentity,
  deleteRoom,
  roomRef,
  signInEmulatorIdentity,
} from "../helpers/emulator.mjs";

const roomId = "operation8-vercel-api";
const questionId = "vercel-question-01";
const localOrigin = "http://127.0.0.1:5173";

function responseMock() {
  return {
    body: null,
    headers: {},
    statusCode: 200,
    ended: false,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      this.ended = true;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

async function invoke(handler, { method = "POST", token, action, data = {}, origin = localOrigin } = {}) {
  const body = action === undefined ? undefined : { action, data };
  const headers = {
    ...(origin ? { origin } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body ? { "content-length": String(Buffer.byteLength(JSON.stringify(body))) } : {}),
  };
  const req = { method, headers, body };
  const res = responseMock();
  await handler(req, res);
  return res;
}

async function localApiFetch(url, options) {
  const handlers = {
    "/api/admin": adminHandler,
    "/api/player": playerHandler,
    "/api/quiz": quizHandler,
  };
  const handler = handlers[url];
  if (!handler) throw new TypeError(`No local API handler for ${url}`);
  const req = {
    method: options.method,
    headers: {
      ...Object.fromEntries(
        Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value]),
      ),
      origin: localOrigin,
      "content-length": String(Buffer.byteLength(options.body || "")),
    },
    body: options.body,
  };
  const res = responseMock();
  await handler(req, res);
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    async json() {
      return res.body;
    },
  };
}

function tokenAuth(token) {
  return {
    currentUser: {
      async getIdToken() {
        return token;
      },
    },
  };
}

test("Vercel API uses the shared server operations safely", { timeout: 90_000 }, async (t) => {
  const [adminIdentity, playerIdentity, otherIdentity] = await Promise.all([
    createEmulatorIdentity({ admin: true, label: "operation8-admin" }),
    createEmulatorIdentity({ label: "operation8-player" }),
    createEmulatorIdentity({ label: "operation8-other" }),
  ]);
  const [adminToken, playerToken, otherToken] = await Promise.all([
    signInEmulatorIdentity(adminIdentity),
    signInEmulatorIdentity(playerIdentity),
    signInEmulatorIdentity(otherIdentity),
  ]);

  t.after(async () => {
    await deleteRoom(roomId);
    await Promise.all(
      [adminIdentity, playerIdentity, otherIdentity].map((identity) =>
        deleteEmulatorIdentity(identity.uid)
      )
    );
  });

  await t.test("health endpoint returns only safe service metadata", async () => {
    const response = await invoke(healthHandler, { method: "GET" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      ok: true,
      data: {
        status: "ok",
        service: "family-quiz-vercel-api",
        environment: "local-emulator",
        transport: "vercel",
      },
    });
  });

  await t.test("missing token is rejected", async () => {
    const response = await invoke(playerHandler, { action: "recoverPlayer", data: { roomId } });
    assert.equal(response.statusCode, 401);
    assert.equal(response.body.error.code, "missing-token");
  });

  await t.test("invalid token is rejected", async () => {
    const response = await invoke(playerHandler, {
      token: "not-a-valid-token",
      action: "recoverPlayer",
      data: { roomId },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.body.error.code, "invalid-token");
  });

  await t.test("unsupported method is rejected", async () => {
    const response = await invoke(playerHandler, { method: "GET" });
    assert.equal(response.statusCode, 405);
    assert.equal(response.body.error.code, "method-not-allowed");
  });

  await t.test("unknown action is rejected", async () => {
    const response = await invoke(playerHandler, {
      token: playerToken,
      action: "unknownPlayerAction",
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.body.error.code, "unknown-action");
  });

  await t.test("non-admin cannot call the admin endpoint", async () => {
    const response = await invoke(adminHandler, {
      token: playerToken,
      action: "getPlayerPrivateDetails",
      data: { roomId, playerId: "missing" },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.body.error.code, "permission-denied");
  });

  await t.test("unauthenticated user cannot initialize the quiz", async () => {
    const response = await invoke(adminHandler, {
      action: "initializeQuiz",
      data: { roomId },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.body.error.code, "missing-token");
  });

  await t.test("non-admin cannot initialize the quiz", async () => {
    const response = await invoke(adminHandler, {
      token: playerToken,
      action: "initializeQuiz",
      data: { roomId },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.body.error.code, "permission-denied");
  });

  await t.test("admin initializes one room idempotently through Vercel", async () => {
    await deleteRoom(roomId);
    const first = await invoke(adminHandler, {
      token: adminToken,
      action: "initializeQuiz",
      data: { roomId },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.body.data.status, "created");
    const firstSnapshot = await roomRef(roomId).get();
    assert.equal(firstSnapshot.exists, true);
    assert.equal(firstSnapshot.data().stage, "home");
    assert.equal(firstSnapshot.data().activePackageId, "default");

    const repeated = await invoke(adminHandler, {
      token: adminToken,
      action: "initializeQuiz",
      data: { roomId },
    });
    assert.equal(repeated.statusCode, 200);
    assert.equal(repeated.body.data.status, "initialized");
    assert.equal(repeated.body.data.roomId, roomId);
    const repeatedSnapshot = await roomRef(roomId).get();
    assert.equal(repeatedSnapshot.exists, true);
    assert.equal(repeatedSnapshot.data().createdAt.isEqual(firstSnapshot.data().createdAt), true);
  });

  await t.test("initialization rejects untrusted identity and project fields", async () => {
    const response = await invoke(adminHandler, {
      token: adminToken,
      action: "initializeQuiz",
      data: { roomId, uid: "forged", projectId: "production" },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error.code, "invalid-argument");
  });

  const room = roomRef(roomId);
  await room.set({
    stage: "registration",
    currentQuestion: null,
    acceptingAnswers: false,
    activeQuestionId: null,
  });
  await room.collection("questions").doc(questionId).set({
    text: "Vercel shared operation",
    options: ["A", "B", "C"],
    correctIndex: 1,
    maxPoints: 1000,
    minPoints: 100,
    seconds: 20,
    answerRevealDelaySeconds: 0,
  });

  const registration = await invoke(playerHandler, {
    token: playerToken,
    action: "registerPlayer",
    data: {
      roomId,
      name: "Vercel Player",
      emoji: "P1",
      fullName: "Vercel Player Full",
      phone: "0500000801",
    },
  });
  assert.equal(registration.statusCode, 200);
  const playerId = registration.body.data.playerId;

  const otherRegistration = await invoke(playerHandler, {
    token: otherToken,
    action: "registerPlayer",
    data: {
      roomId,
      name: "Other Player",
      emoji: "P2",
      fullName: "Other Player Full",
      phone: "0500000802",
    },
  });
  assert.equal(otherRegistration.statusCode, 200);
  const otherPlayerId = otherRegistration.body.data.playerId;

  await t.test("public player data excludes private identity fields", async () => {
    const publicPlayer = (await room.collection("players").doc(playerId).get()).data();
    for (const field of ["phone", "phoneNormalized", "fullName", "authUid"]) {
      assert.equal(publicPlayer[field], undefined);
      assert.equal(registration.body.data[field], undefined);
      assert.equal(registration.body.data.player?.[field], undefined);
    }
  });

  await t.test("playerPrivate details are available only to an admin", async () => {
    const denied = await invoke(adminHandler, {
      token: playerToken,
      action: "getPlayerPrivateDetails",
      data: { roomId, playerId },
    });
    assert.equal(denied.statusCode, 403);
    const allowed = await invoke(adminHandler, {
      token: adminToken,
      action: "getPlayerPrivateDetails",
      data: { roomId, playerId },
    });
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.body.data.details.phone, "0500000801");
    assert.equal(allowed.body.data.details.fullName, "Vercel Player Full");
  });

  await t.test("owner updates only the allowed profile fields", async () => {
    const response = await invoke(playerHandler, {
      token: playerToken,
      action: "updatePlayerProfile",
      data: {
        roomId,
        playerId,
        name: "Updated Owner",
        emoji: "UP",
        fullName: "Updated Owner Full",
        phone: "0500000811",
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.data.status, "updated");
    assert.equal(response.body.data.player.name, "Updated Owner");
    for (const field of ["phone", "phoneNormalized", "fullName", "authUid"]) {
      assert.equal(response.body.data[field], undefined);
      assert.equal(response.body.data.player?.[field], undefined);
    }
    const [publicPlayer, privatePlayer] = await Promise.all([
      room.collection("players").doc(playerId).get(),
      room.collection("playerPrivate").doc(playerId).get(),
    ]);
    assert.equal(publicPlayer.data().name, "Updated Owner");
    assert.equal(publicPlayer.data().fullName, undefined);
    assert.equal(privatePlayer.data().fullName, "Updated Owner Full");
    assert.equal(privatePlayer.data().phoneNormalized, "0500000811");
    assert.equal(privatePlayer.data().authUid, playerIdentity.uid);
  });

  await t.test("owner cannot update another player", async () => {
    const response = await invoke(playerHandler, {
      token: playerToken,
      action: "updatePlayerProfile",
      data: { roomId, playerId: otherPlayerId, name: "Not Allowed" },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.body.error.code, "permission-denied");
  });

  await t.test("owner cannot update score, rank, joker, or identity fields", async () => {
    for (const forbidden of [
      { score: 9999 },
      { rank: 1 },
      { jokerUsed: false },
      { authUid: playerIdentity.uid },
    ]) {
      const response = await invoke(playerHandler, {
        token: playerToken,
        action: "updatePlayerProfile",
        data: { roomId, playerId, ...forbidden },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.body.error.code, "invalid-argument");
    }
    const publicPlayer = (await room.collection("players").doc(playerId).get()).data();
    assert.equal(publicPlayer.score, 0);
    assert.equal(publicPlayer.rank, null);
    assert.equal(publicPlayer.jokerUsed, false);
  });

  await t.test("admin updates another player through the admin route", async () => {
    const response = await invoke(adminHandler, {
      token: adminToken,
      action: "updatePlayerProfile",
      data: {
        roomId,
        playerId: otherPlayerId,
        name: "Admin Updated",
        fullName: "Admin Updated Private",
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.data.player.name, "Admin Updated");
    assert.equal(response.body.data.player.fullName, undefined);
    const [publicPlayer, privatePlayer] = await Promise.all([
      room.collection("players").doc(otherPlayerId).get(),
      room.collection("playerPrivate").doc(otherPlayerId).get(),
    ]);
    assert.equal(publicPlayer.data().name, "Admin Updated");
    assert.equal(publicPlayer.data().fullName, undefined);
    assert.equal(privatePlayer.data().fullName, "Admin Updated Private");
    assert.equal(privatePlayer.data().authUid, otherIdentity.uid);
  });

  await t.test("activating the joker twice consumes only one joker", async () => {
    const first = await invoke(playerHandler, {
      token: playerToken,
      action: "activateJoker",
      data: { roomId, questionId: "next", playerId },
    });
    const second = await invoke(playerHandler, {
      token: playerToken,
      action: "activateJoker",
      data: { roomId, questionId: "next", playerId },
    });
    assert.equal(first.body.data.status, "pending");
    assert.equal(second.body.data.status, "already-pending");
    const player = (await room.collection("players").doc(playerId).get()).data();
    assert.equal(player.pendingJoker, true);
    assert.equal(player.jokerUsed, false);
  });

  const prepared = await invoke(quizHandler, {
    token: adminToken,
    action: "prepareQuestion",
    data: { roomId, questionId, questionIndex: 0 },
  });
  assert.equal(prepared.statusCode, 200);
  const started = await invoke(quizHandler, {
    token: adminToken,
    action: "startQuestion",
    data: { roomId, questionId },
  });
  assert.equal(started.statusCode, 200);

  await t.test("player cannot submit an answer for another player", async () => {
    const response = await invoke(playerHandler, {
      token: playerToken,
      action: "submitAnswer",
      data: { roomId, questionId, playerId: otherPlayerId, selectedIndex: 1 },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.body.error.code, "permission-denied");
  });

  await t.test("submitAnswer succeeds with the authenticated owner", async () => {
    const response = await invoke(playerHandler, {
      token: playerToken,
      action: "submitAnswer",
      data: { roomId, questionId, playerId, selectedIndex: 1 },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.data.status, "received");
  });

  await t.test("duplicate submitAnswer does not create another answer", async () => {
    const response = await invoke(playerHandler, {
      token: playerToken,
      action: "submitAnswer",
      data: { roomId, questionId, playerId, selectedIndex: 0 },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.error.code, "already-exists");
    const answers = await room.collection("answers").where("playerId", "==", playerId).get();
    assert.equal(answers.size, 1);
    assert.equal(answers.docs[0].data().selectedIndex, 1);
  });

  await invoke(quizHandler, {
    token: adminToken,
    action: "controlQuestion",
    data: { roomId, questionId, action: "reveal" },
  });

  await t.test("finalizeQuestion remains idempotent across two HTTP calls", async () => {
    const first = await invoke(quizHandler, {
      token: adminToken,
      action: "finalizeQuestion",
      data: { roomId, questionId },
    });
    const second = await invoke(quizHandler, {
      token: adminToken,
      action: "finalizeQuestion",
      data: { roomId, questionId },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.body.data.status, "finalized");
    assert.equal(second.statusCode, 200);
    assert.equal(second.body.data.status, "already-finalized");
    assert.equal(first.body.data.runId, second.body.data.runId);
    const results = await room.collection("questionResults").get();
    assert.equal(results.size, 1);
  });

  await t.test("unified React adapter completes the critical Vercel flow on emulators", async () => {
    const adapterRoomId = "operation9-client-adapter";
    const adapterQuestionId = "adapter-question-01";
    const adapterRoom = roomRef(adapterRoomId);
    await adapterRoom.set({
      stage: "registration",
      currentQuestion: null,
      acceptingAnswers: false,
      activeQuestionId: null,
    });
    await adapterRoom.collection("questions").doc(adapterQuestionId).set({
      text: "Unified adapter question",
      options: ["A", "B"],
      correctIndex: 0,
      maxPoints: 1000,
      minPoints: 100,
      seconds: 20,
      answerRevealDelaySeconds: 0,
    });
    t.after(() => deleteRoom(adapterRoomId));

    const playerClient = createServerApiClient({
      transport: "vercel",
      auth: tokenAuth(playerToken),
      fetchImpl: localApiFetch,
    });
    const adminClient = createServerApiClient({
      transport: "vercel",
      auth: tokenAuth(adminToken),
      fetchImpl: localApiFetch,
    });
    const registrationResult = await playerClient.registerPlayer({
      roomId: adapterRoomId,
      name: "Adapter Player",
      emoji: "AP",
      fullName: "Adapter Player Full",
      phone: "0500000891",
    });
    const adapterPlayerId = registrationResult.playerId;
    assert.equal(registrationResult.status, "registered");
    assert.equal(
      (await playerClient.activateJoker({
        roomId: adapterRoomId,
        questionId: "next",
        playerId: adapterPlayerId,
      })).status,
      "pending",
    );
    assert.equal(
      (await adminClient.prepareQuestion({
        roomId: adapterRoomId,
        questionId: adapterQuestionId,
        questionIndex: 0,
      })).status,
      "prepared",
    );
    assert.equal(
      (await adminClient.startQuestion({
        roomId: adapterRoomId,
        questionId: adapterQuestionId,
      })).status,
      "started",
    );
    assert.equal(
      (await playerClient.submitAnswer({
        roomId: adapterRoomId,
        questionId: adapterQuestionId,
        playerId: adapterPlayerId,
        selectedIndex: 0,
      })).status,
      "received",
    );
    await adminClient.controlQuestion({
      roomId: adapterRoomId,
      questionId: adapterQuestionId,
      action: "reveal",
    });
    assert.equal(
      (await adminClient.finalizeQuestion({
        roomId: adapterRoomId,
        questionId: adapterQuestionId,
      })).status,
      "finalized",
    );
    const details = await adminClient.getPlayerPrivateDetails({
      roomId: adapterRoomId,
      playerId: adapterPlayerId,
    });
    assert.equal(details.details.fullName, "Adapter Player Full");
    assert.equal(details.details.phone, "0500000891");
  });
});
