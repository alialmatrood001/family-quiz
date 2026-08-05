import assert from "node:assert/strict";
import test from "node:test";
import { deleteApp, initializeApp } from "firebase/app";
import {
  connectAuthEmulator,
  inMemoryPersistence,
  initializeAuth,
  signInWithEmailAndPassword,
} from "firebase/auth";
import {
  collection,
  connectFirestoreEmulator,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
} from "firebase/firestore";
import {
  createEmulatorIdentity,
  deleteEmulatorIdentity,
  deleteRoom,
  roomRef,
  signInEmulatorIdentity,
} from "../helpers/emulator.mjs";
import { invokeApi } from "../helpers/local-vercel-api.mjs";

function browserClient(label, identity = null) {
  const app = initializeApp(
    {
      apiKey: "demo-api-key",
      authDomain: "demo-family-quiz.firebaseapp.com",
      projectId: "demo-family-quiz",
    },
    `${label}-${Date.now()}-${Math.random()}`,
  );
  const firestore = getFirestore(app);
  connectFirestoreEmulator(firestore, "127.0.0.1", 8080);
  if (!identity) return Promise.resolve({ app, firestore });
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  return signInWithEmailAndPassword(auth, identity.email, identity.password).then(() => ({
    app,
    firestore,
  }));
}

function waitForSnapshot(reference, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Snapshot timed out for ${reference.path}`));
    }, timeoutMs);
    unsubscribe = onSnapshot(
      reference,
      (snapshot) => {
        clearTimeout(timeout);
        unsubscribe();
        resolve(snapshot);
      },
      (error) => {
        clearTimeout(timeout);
        unsubscribe();
        reject(error);
      },
    );
  });
}

test("Firestore read rules support every primary UI listener without exposing private data", { timeout: 60_000 }, async (t) => {
  const roomId = "staging-firestore-read-access";
  const [adminIdentity, playerIdentity] = await Promise.all([
    createEmulatorIdentity({ admin: true, label: "rules-admin" }),
    createEmulatorIdentity({ label: "rules-player" }),
  ]);
  const [adminToken, clients] = await Promise.all([
    signInEmulatorIdentity(adminIdentity),
    Promise.all([
      browserClient("rules-admin", adminIdentity),
      browserClient("rules-player", playerIdentity),
      browserClient("rules-guest"),
    ]),
  ]);
  const [adminClient, playerClient, guestClient] = clients;
  t.after(async () => {
    await Promise.all(clients.map(({ app }) => deleteApp(app)));
    await deleteRoom(roomId);
    await Promise.all([
      deleteEmulatorIdentity(adminIdentity.uid),
      deleteEmulatorIdentity(playerIdentity.uid),
    ]);
  });

  const initialized = await invokeApi("admin", {
    token: adminToken,
    action: "initializeQuiz",
    data: { roomId },
  });
  assert.equal(initialized.statusCode, 200);
  assert.equal(initialized.body.ok, true);

  const room = roomRef(roomId);
  await Promise.all([
    room.collection("players").doc("player-1").set({
      name: "Public Player",
      emoji: "P",
      score: 0,
      jokerUsed: false,
    }),
    room.collection("playerPrivate").doc("player-1").set({
      authUid: playerIdentity.uid,
      fullName: "Private Full Name",
      phoneNormalized: "0500000901",
    }),
    room.collection("playerRegistrationKeys").doc("private-key").set({ type: "uid" }),
    room.collection("questions").doc("question-1").set({
      text: "Admin question",
      options: ["A", "B"],
      correctIndex: 0,
    }),
    room.collection("questionSecrets").doc("question-1").set({ correctIndex: 0 }),
    room.collection("answers").doc("question-1_player-1").set({
      questionId: "question-1",
      playerId: "player-1",
      selectedIndex: 0,
    }),
    room.collection("questionResults").doc("question-1").set({
      questionId: "question-1",
      results: [],
    }),
    room.collection("messages").doc("message-1").set({
      playerId: "player-1",
      playerName: "Public Player",
      text: "Hello",
    }),
    room.collection("visitors").doc(adminIdentity.uid).set({ seenAtMs: Date.now() }),
    room.collection("auditLogs").doc("audit-1").set({ action: "test" }),
  ]);

  await t.test("server initialization is immediately readable by the authenticated admin listener", async () => {
    const snapshot = await waitForSnapshot(doc(adminClient.firestore, "rooms", roomId));
    assert.equal(snapshot.exists(), true);
    assert.equal(snapshot.data().stage, "home");
  });

  await t.test("admin can read every collection required by the control page", async () => {
    for (const name of [
      "players",
      "playerPrivate",
      "questions",
      "answers",
      "questionResults",
      "messages",
      "visitors",
      "auditLogs",
    ]) {
      assert.equal(
        (await getDocs(collection(adminClient.firestore, "rooms", roomId, name))).empty,
        false,
        `admin should read ${name}`,
      );
    }
  });

  await t.test("players and guests can read only the public listener data", async () => {
    for (const client of [playerClient, guestClient]) {
      assert.equal((await getDoc(doc(client.firestore, "rooms", roomId))).exists(), true);
      for (const name of ["players", "answers", "questionResults", "messages"]) {
        assert.equal(
          (await getDocs(collection(client.firestore, "rooms", roomId, name))).empty,
          false,
        );
      }
      for (const name of ["playerPrivate", "questions", "visitors", "auditLogs"]) {
        await assert.rejects(
          getDocs(collection(client.firestore, "rooms", roomId, name)),
          (error) => error.code === "permission-denied",
        );
      }
    }
  });

  await t.test("even admins cannot read secret or registration-key collections", async () => {
    for (const name of ["questionSecrets", "playerRegistrationKeys"]) {
      await assert.rejects(
        getDocs(collection(adminClient.firestore, "rooms", roomId, name)),
        (error) => error.code === "permission-denied",
      );
    }
  });

  await t.test("public documents contain no private identity fields", async () => {
    const publicPlayer = (
      await getDoc(doc(guestClient.firestore, "rooms", roomId, "players", "player-1"))
    ).data();
    for (const field of ["authUid", "fullName", "phone", "phoneNormalized"]) {
      assert.equal(publicPlayer[field], undefined);
    }
  });
});
