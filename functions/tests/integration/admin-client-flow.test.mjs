import assert from "node:assert/strict";
import test from "node:test";
import { deleteApp, initializeApp } from "firebase/app";
import {
  connectAuthEmulator,
  inMemoryPersistence,
  initializeAuth,
} from "firebase/auth";
import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";
import { connectFunctionsEmulator, getFunctions } from "firebase/functions";
import { createAdminAuthService } from "../../../src/admin-auth.js";
import {
  createQuestionFinalizationClient,
  waitForOfficialQuestionResult,
} from "../../../src/finalize-question-client.js";
import {
  createFirebaseCallableInvoker,
  createServerApiClient,
} from "../../../src/server-api-client.js";
import { buildScenario } from "../fixtures/scenarios.mjs";
import {
  createEmulatorIdentity,
  deleteEmulatorIdentity,
  deleteRoom,
  readState,
  setEmulatorAdminClaim,
  writeScenario,
} from "../helpers/emulator.mjs";

test("authenticated React client finalizes once and waits for the official result", { timeout: 45_000 }, async (t) => {
  const scenario = buildScenario({
    roomId: "operation5-admin-client",
    playerCount: 12,
    correctCount: 8,
    wrongCount: 2,
  });
  const app = initializeApp({
    apiKey: "demo-api-key",
    authDomain: "demo-family-quiz.firebaseapp.com",
    projectId: "demo-family-quiz",
  }, `operation5-${Date.now()}`);
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  const firestore = getFirestore(app);
  const functions = getFunctions(app, "us-central1");
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(firestore, "127.0.0.1", 8080);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);

  const authService = createAdminAuthService(auth);
  const serverClient = createServerApiClient({
    transport: "callable",
    auth,
    callableInvoker: createFirebaseCallableInvoker(functions),
  });
  const finalizationClient = createQuestionFinalizationClient({
    firestore,
    finalizeOperation: serverClient.finalizeQuestion,
    resultTimeoutMs: 10_000,
  });
  const ordinary = await createEmulatorIdentity({ label: "operation5-ordinary" });
  const admin = await createEmulatorIdentity({ admin: true, label: "operation5-admin" });

  t.after(async () => {
    await authService.signOut().catch(() => {});
    await Promise.all([
      deleteEmulatorIdentity(ordinary.uid),
      deleteEmulatorIdentity(admin.uid),
      deleteRoom(scenario.roomId),
    ]);
    await deleteApp(app);
  });

  await assert.rejects(
    finalizationClient.finalizeAndWait({
      roomId: scenario.roomId,
      questionId: scenario.questionId,
    }),
    (error) => error.code === "unauthenticated",
  );

  const ordinarySession = await authService.signIn(ordinary.email, ordinary.password);
  assert.equal(ordinarySession.isAdmin, false);
  await writeScenario(scenario);
  await assert.rejects(
    finalizationClient.finalizeAndWait({
      roomId: scenario.roomId,
      questionId: scenario.questionId,
    }),
    (error) => error.code === "permission-denied",
  );

  await setEmulatorAdminClaim(ordinary.uid, true);
  const refreshedSession = await authService.refreshClaims();
  assert.equal(refreshedSession.isAdmin, true);
  await authService.signOut();

  const adminSession = await authService.signIn(admin.email, admin.password);
  assert.equal(adminSession.isAdmin, true);

  const first = finalizationClient.finalizeAndWait({
    roomId: scenario.roomId,
    questionId: scenario.questionId,
  });
  const second = finalizationClient.finalizeAndWait({
    roomId: scenario.roomId,
    questionId: scenario.questionId,
  });
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.officialResult.questionId, scenario.questionId);
  assert.deepEqual(secondResult.officialResult, firstResult.officialResult);

  const afterConcurrent = await readState(scenario.roomId);
  assert.equal(afterConcurrent.results.length, 1);
  const scoresAfterConcurrent = Object.fromEntries(
    afterConcurrent.players.map((player) => [player.id, player.score]),
  );

  const reloadedClient = createQuestionFinalizationClient({
    firestore,
    finalizeOperation: serverClient.finalizeQuestion,
    resultTimeoutMs: 10_000,
  });
  const afterReload = await reloadedClient.finalizeAndWait({
    roomId: scenario.roomId,
    questionId: scenario.questionId,
  });
  assert.equal(afterReload.officialResult.questionId, scenario.questionId);
  const finalState = await readState(scenario.roomId);
  assert.deepEqual(
    Object.fromEntries(finalState.players.map((player) => [player.id, player.score])),
    scoresAfterConcurrent,
  );

  await assert.rejects(
    waitForOfficialQuestionResult(firestore, {
      roomId: scenario.roomId,
      questionId: "missing-result",
      timeoutMs: 50,
    }),
    (error) => error.code === "deadline-exceeded",
  );

  await authService.signOut();
  assert.equal(auth.currentUser, null);
});
