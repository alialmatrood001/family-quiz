import assert from "node:assert/strict";
import test from "node:test";
import { createAnonymousPlayerAuthEnsurer } from "../../../src/player-auth-core.js";
import {
  readStoredPlayerSession,
  restoreAuthenticatedPlayerSession,
  writeStoredPlayerSession,
} from "../../../src/player-session.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

test("anonymous auth waits for persisted auth restoration before considering a new sign-in", async () => {
  let releaseReady;
  let signInCount = 0;
  const restoredUser = { uid: "persisted-anonymous-uid" };
  const auth = {
    currentUser: null,
    async authStateReady() {
      await new Promise((resolve) => {
        releaseReady = resolve;
      });
      this.currentUser = restoredUser;
    },
  };
  const ensure = createAnonymousPlayerAuthEnsurer({
    auth,
    async signInAnonymously() {
      signInCount += 1;
      return { user: { uid: "new-uid" } };
    },
  });

  const pending = ensure();
  await Promise.resolve();
  assert.equal(signInCount, 0);
  releaseReady();
  assert.equal(await pending, restoredUser);
  assert.equal(signInCount, 0);
});

test("concurrent first-time auth requests create only one anonymous identity", async () => {
  let signInCount = 0;
  const user = { uid: "first-uid" };
  const auth = { currentUser: null, authStateReady: async () => {} };
  const ensure = createAnonymousPlayerAuthEnsurer({
    auth,
    async signInAnonymously() {
      signInCount += 1;
      return { user };
    },
  });
  const [first, second] = await Promise.all([ensure(), ensure()]);
  assert.equal(first, user);
  assert.equal(second, user);
  assert.equal(signInCount, 1);
});

test("registration session stores only player id and the authenticated local UID binding", () => {
  const storage = memoryStorage();
  writeStoredPlayerSession(storage, { playerId: "player-1", authUid: "uid-1" });
  assert.deepEqual(readStoredPlayerSession(storage), {
    playerId: "player-1",
    authUid: "uid-1",
  });
});

test("reload after question one reuses a valid bound player without recoverPlayer", async () => {
  let recoverCount = 0;
  const result = await restoreAuthenticatedPlayerSession({
    authenticatedUser: { uid: "uid-1" },
    storedSession: { playerId: "player-1", authUid: "uid-1" },
    readPublicPlayer: async () => ({ id: "player-1", name: "Player" }),
    recoverPlayer: async () => {
      recoverCount += 1;
      throw new Error("recoverPlayer must not run");
    },
  });
  assert.equal(result.status, "current-session");
  assert.equal(result.playerId, "player-1");
  assert.equal(recoverCount, 0);
});

test("a missing or mismatched local binding can recover only through the authenticated server", async () => {
  const result = await restoreAuthenticatedPlayerSession({
    authenticatedUser: { uid: "uid-1" },
    storedSession: { playerId: "player-other", authUid: "uid-other" },
    readPublicPlayer: async () => {
      throw new Error("an untrusted binding must not be reused");
    },
    recoverPlayer: async () => ({
      status: "recovered",
      playerId: "player-1",
      player: { name: "Player" },
    }),
  });
  assert.equal(result.playerId, "player-1");
});

test("failed player recovery cannot block an independent admin finalization", async () => {
  const adminFinalization = Promise.resolve({ status: "finalized", questionId: "question-1" });
  const playerRecovery = restoreAuthenticatedPlayerSession({
    authenticatedUser: { uid: "different-uid" },
    storedSession: { playerId: "player-1", authUid: "old-uid" },
    readPublicPlayer: async () => null,
    recoverPlayer: async () => {
      throw Object.assign(new Error("No linked player"), { code: "not-found" });
    },
  });
  const [adminResult, playerResult] = await Promise.allSettled([
    adminFinalization,
    playerRecovery,
  ]);
  assert.equal(adminResult.status, "fulfilled");
  assert.equal(adminResult.value.status, "finalized");
  assert.equal(playerResult.status, "rejected");
  assert.equal(playerResult.reason.code, "not-found");
});
