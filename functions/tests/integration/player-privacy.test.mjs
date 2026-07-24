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
  setDoc,
} from "firebase/firestore";
import {
  callCallable,
  createEmulatorIdentity,
  deleteEmulatorIdentity,
  deleteRoom,
  roomRef,
  signInEmulatorIdentity,
} from "../helpers/emulator.mjs";

function browserClient(identity, label) {
  const app = initializeApp(
    {
      apiKey: "demo-api-key",
      authDomain: "demo-family-quiz.firebaseapp.com",
      projectId: "demo-family-quiz",
    },
    `${label}-${Date.now()}-${Math.random()}`
  );
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  const firestore = getFirestore(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(firestore, "127.0.0.1", 8080);
  return signInWithEmailAndPassword(auth, identity.email, identity.password).then(() => ({
    app,
    firestore,
  }));
}

test("player public/private registration, recovery, rules and atomic deletion preserve privacy", { timeout: 60_000 }, async (t) => {
  const roomId = "operation7-player-privacy";
  const [admin, first, second] = await Promise.all([
    createEmulatorIdentity({ admin: true, label: "operation7-admin" }),
    createEmulatorIdentity({ label: "operation7-first" }),
    createEmulatorIdentity({ label: "operation7-second" }),
  ]);
  const [adminToken, firstToken, secondToken] = await Promise.all([
    signInEmulatorIdentity(admin),
    signInEmulatorIdentity(first),
    signInEmulatorIdentity(second),
  ]);
  const clients = await Promise.all([
    browserClient(first, "operation7-first-client"),
    browserClient(second, "operation7-second-client"),
    browserClient(admin, "operation7-admin-client"),
  ]);
  t.after(async () => {
    await Promise.all(clients.map(({ app }) => deleteApp(app)));
    await deleteRoom(roomId);
    await Promise.all([admin, first, second].map(({ uid }) => deleteEmulatorIdentity(uid)));
  });

  const ref = roomRef(roomId);
  await ref.set({
    stage: "registration",
    currentQuestion: null,
    acceptingAnswers: false,
    activeQuestionId: null,
  });
  const registrationData = {
    roomId,
    name: "Private One",
    emoji: "🔒",
    fullName: "Full Private One",
    phone: "0500000101",
  };
  const duplicateRegistration = await Promise.all([
    callCallable("registerPlayer", registrationData, { token: firstToken }),
    callCallable("registerPlayer", registrationData, { token: firstToken }),
  ]);
  assert.equal(duplicateRegistration[0].playerId, duplicateRegistration[1].playerId);
  const firstPlayerId = duplicateRegistration[0].playerId;
  const secondRegistration = await callCallable(
    "registerPlayer",
    {
      roomId,
      name: "Private Two",
      emoji: "🛡️",
      fullName: "Full Private Two",
      phone: "0500000102",
    },
    { token: secondToken }
  );

  assert.equal((await ref.collection("players").get()).size, 2);
  assert.equal((await ref.collection("playerPrivate").get()).size, 2);
  const publicData = (await ref.collection("players").doc(firstPlayerId).get()).data();
  for (const forbidden of ["authUid", "fullName", "phone", "phoneNormalized", "recoveryNameNormalized"]) {
    assert.equal(publicData[forbidden], undefined);
  }
  const privateData = (await ref.collection("playerPrivate").doc(firstPlayerId).get()).data();
  assert.equal(privateData.authUid, first.uid);
  assert.equal(privateData.phoneNormalized, "0500000101");

  const recovered = await callCallable("recoverPlayer", { roomId }, { token: firstToken });
  assert.equal(recovered.playerId, firstPlayerId);
  assert.deepEqual(Object.keys(recovered.player).sort(), ["displayName", "emoji", "name"]);
  await assert.rejects(
    callCallable("getPlayerPrivateDetails", { roomId, playerId: firstPlayerId }, { token: firstToken }),
    (error) => error.code === "PERMISSION_DENIED"
  );
  const adminDetails = await callCallable(
    "getPlayerPrivateDetails",
    { roomId, playerId: firstPlayerId },
    { token: adminToken }
  );
  assert.deepEqual(Object.keys(adminDetails.details).sort(), ["fullName", "phone"]);

  const [firstClient, secondClient, adminClient] = clients;
  assert.ok((await getDoc(doc(firstClient.firestore, "rooms", roomId, "players", firstPlayerId))).exists());
  await assert.rejects(
    getDoc(doc(firstClient.firestore, "rooms", roomId, "playerPrivate", firstPlayerId)),
    (error) => error.code === "permission-denied"
  );
  await assert.rejects(
    getDoc(doc(firstClient.firestore, "rooms", roomId, "playerPrivate", secondRegistration.playerId)),
    (error) => error.code === "permission-denied"
  );
  await assert.rejects(
    getDocs(collection(firstClient.firestore, "rooms", roomId, "playerPrivate")),
    (error) => error.code === "permission-denied"
  );
  assert.equal(
    (await getDocs(collection(adminClient.firestore, "rooms", roomId, "playerPrivate"))).size,
    2
  );
  await assert.rejects(
    setDoc(
      doc(secondClient.firestore, "rooms", roomId, "playerPrivate", firstPlayerId),
      { authUid: second.uid },
      { merge: true }
    ),
    (error) => error.code === "permission-denied"
  );

  await callCallable(
    "updatePlayerProfile",
    { roomId, playerId: firstPlayerId, name: "Private One Updated", emoji: "✅" },
    { token: firstToken }
  );
  const updatedPublic = (await ref.collection("players").doc(firstPlayerId).get()).data();
  assert.equal(updatedPublic.name, "Private One Updated");
  assert.equal(updatedPublic.authUid, undefined);

  await callCallable(
    "deletePlayer",
    { roomId, playerId: secondRegistration.playerId, reason: "اختبار حذف ذري" },
    { token: adminToken }
  );
  assert.equal((await ref.collection("players").doc(secondRegistration.playerId).get()).exists, false);
  assert.equal(
    (await ref.collection("playerPrivate").doc(secondRegistration.playerId).get()).exists,
    false
  );
  const auditText = JSON.stringify(
    (await ref.collection("auditLogs").get()).docs.map((document) => document.data())
  );
  assert.equal(auditText.includes("0500000102"), false);
  assert.equal(auditText.includes("Full Private Two"), false);
  assert.equal(auditText.includes(second.uid), false);
});
