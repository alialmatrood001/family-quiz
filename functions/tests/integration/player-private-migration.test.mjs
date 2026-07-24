import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { db, deleteRoom, roomRef } from "../helpers/emulator.mjs";

const require = createRequire(import.meta.url);
const { migratePlayerPrivateData } = require("../../player-private/migration.js");

test("player private migration supports dry-run, apply and idempotent rerun", { timeout: 30_000 }, async (t) => {
  const roomId = "operation7-migration";
  const ref = roomRef(roomId);
  t.after(() => deleteRoom(roomId));
  await ref.set({
    stage: "registration",
    gameHistory: [{
      id: "legacy-game",
      players: [{ id: "legacy", name: "Legacy", fullName: "Legacy Full", phone: "0500000201" }],
      prizeWinners: [{ playerId: "legacy", playerName: "Legacy", playerFullName: "Legacy Full" }],
    }],
    prizeWheel: {
      winners: [{ playerId: "legacy", playerName: "Legacy", playerFullName: "Legacy Full" }],
    },
  });
  await Promise.all([
    ref.collection("players").doc("legacy").set({
      name: "Legacy",
      score: 0,
      authUid: "legacy-uid",
      fullName: "Legacy Full",
      phone: "0500000201",
    }),
    ref.collection("players").doc("already-migrated").set({
      name: "Already",
      score: 0,
    }),
    ref.collection("playerPrivate").doc("already-migrated").set({
      authUid: "already-uid",
      fullName: "Already Full",
      phoneNormalized: "0500000202",
    }),
    ref.collection("players").doc("missing-phone").set({
      name: "Missing Phone",
      score: 0,
      authUid: "missing-phone-uid",
      fullName: "Missing Phone Full",
    }),
  ]);

  const dryRun = await migratePlayerPrivateData({
    db,
    roomId,
    dryRun: true,
    now: () => Timestamp.now(),
  });
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.counts.privateCreated, 2);
  assert.equal((await ref.collection("players").doc("legacy").get()).data().phone, "0500000201");

  const applied = await migratePlayerPrivateData({
    db,
    roomId,
    dryRun: false,
    now: () => Timestamp.now(),
  });
  assert.equal(applied.dryRun, false);
  const publicPlayers = await ref.collection("players").get();
  for (const document of publicPlayers.docs) {
    const data = document.data();
    assert.equal(data.authUid, undefined);
    assert.equal(data.fullName, undefined);
    assert.equal(data.phone, undefined);
    assert.equal(data.phoneNormalized, undefined);
  }
  assert.equal(
    (await ref.collection("playerPrivate").doc("legacy").get()).data().phoneNormalized,
    "0500000201"
  );
  assert.equal(
    (await ref.collection("playerPrivate").doc("missing-phone").get()).data().phoneNormalized,
    undefined
  );
  const sanitizedRoom = (await ref.get()).data();
  assert.equal(sanitizedRoom.gameHistory[0].players[0].fullName, undefined);
  assert.equal(sanitizedRoom.gameHistory[0].players[0].phone, undefined);
  assert.equal(sanitizedRoom.prizeWheel.winners[0].playerFullName, undefined);

  const rerun = await migratePlayerPrivateData({
    db,
    roomId,
    dryRun: false,
    now: () => Timestamp.now(),
  });
  assert.equal(rerun.counts.privateCreated, 0);
  assert.equal(rerun.counts.publicSanitized, 0);
  assert.equal(rerun.counts.conflicts, 0);
});

test("player private migration refuses conflicting private data without changing public data", async (t) => {
  const roomId = "operation7-migration-conflict";
  const ref = roomRef(roomId);
  t.after(() => deleteRoom(roomId));
  await ref.set({ stage: "registration" });
  await Promise.all([
    ref.collection("players").doc("conflict").set({
      name: "Conflict",
      authUid: "uid-one",
      fullName: "First Full",
      phone: "0500000301",
    }),
    ref.collection("playerPrivate").doc("conflict").set({
      authUid: "uid-two",
      fullName: "Second Full",
      phoneNormalized: "0500000302",
    }),
  ]);
  await assert.rejects(
    migratePlayerPrivateData({
      db,
      roomId,
      dryRun: false,
      now: () => Timestamp.now(),
    }),
    (error) => error.code === "migration-conflict"
  );
  assert.equal((await ref.collection("players").doc("conflict").get()).data().phone, "0500000301");
});
