"use strict";

const crypto = require("node:crypto");

const PRIVATE_FIELDS = [
  "authUid",
  "fullName",
  "phone",
  "phoneNormalized",
  "recoveryNameNormalized",
];

function normalizedPrivateData(player) {
  const fullName = String(player.fullName || "").trim().replace(/\s+/g, " ");
  const phoneNormalized = String(player.phoneNormalized || player.phone || "").replace(/\D/g, "");
  return {
    ...(player.authUid ? { authUid: String(player.authUid) } : {}),
    ...(fullName
      ? {
          fullName,
          recoveryNameNormalized: String(
            player.recoveryNameNormalized || fullName.toLocaleLowerCase("ar")
          ),
        }
      : {}),
    ...(phoneNormalized ? { phoneNormalized } : {}),
  };
}

function publicWithoutPrivate(player) {
  return Object.fromEntries(
    Object.entries(player).filter(([key]) => !PRIVATE_FIELDS.includes(key))
  );
}

function valuesConflict(existing, incoming) {
  return Object.entries(incoming).some(
    ([key, value]) =>
      existing[key] !== undefined &&
      existing[key] !== null &&
      existing[key] !== "" &&
      existing[key] !== value
  );
}

function registrationKeyId(type, value) {
  return crypto
    .createHash("sha256")
    .update(`${type}\0${String(value || "").trim().toLocaleLowerCase("ar")}`)
    .digest("hex");
}

function withoutFields(value, fields) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([key]) => !fields.includes(key))
  );
}

function sanitizeRoomArchives(room) {
  const gameHistory = Array.isArray(room.gameHistory)
    ? room.gameHistory.map((game) => ({
        ...game,
        players: Array.isArray(game.players)
          ? game.players.map((player) => withoutFields(player, ["fullName", "phone"]))
          : [],
        prizeWinners: Array.isArray(game.prizeWinners)
          ? game.prizeWinners.map((winner) => withoutFields(winner, ["playerFullName"]))
          : [],
      }))
    : room.gameHistory;
  const prizeWheel = room.prizeWheel && typeof room.prizeWheel === "object"
    ? {
        ...room.prizeWheel,
        winners: Array.isArray(room.prizeWheel.winners)
          ? room.prizeWheel.winners.map((winner) =>
              withoutFields(winner, ["playerFullName"])
            )
          : room.prizeWheel.winners,
      }
    : room.prizeWheel;
  return { gameHistory, prizeWheel };
}

async function migratePlayerPrivateData({ db, roomId, dryRun = true, now }) {
  const roomRef = db.doc(`rooms/${roomId}`);
  const [roomSnapshot, playersSnapshot] = await Promise.all([
    roomRef.get(),
    roomRef.collection("players").get(),
  ]);
  const counts = {
    scanned: playersSnapshot.size,
    privateCreated: 0,
    privateUpdated: 0,
    publicSanitized: 0,
    visitorsMoved: 0,
    unchanged: 0,
    conflicts: 0,
    roomArchivesSanitized: 0,
    registrationKeysCreated: 0,
  };
  const operations = [];

  for (const playerDocument of playersSnapshot.docs) {
    const player = playerDocument.data();
    if (player.isVisitorOnly === true || playerDocument.id.startsWith("visitor-")) {
      const visitorId = String(player.authUid || playerDocument.id.replace(/^visitor-/, ""));
      if (!visitorId) {
        counts.conflicts += 1;
        continue;
      }
      operations.push({
        type: "visitor",
        publicRef: playerDocument.ref,
        visitorRef: roomRef.collection("visitors").doc(visitorId),
        visitor: {
          seenAtMs: Number(player.seenAtMs || 0),
          seenAt: player.seenAt || null,
          playerId: player.playerId || null,
          playerName: player.playerName || "",
          registered: player.registered === true,
        },
      });
      counts.visitorsMoved += 1;
      continue;
    }

    const privateData = normalizedPrivateData(player);
    const hasPrivateFields = PRIVATE_FIELDS.some((field) => player[field] !== undefined);
    const privateRef = roomRef.collection("playerPrivate").doc(playerDocument.id);
    const privateSnapshot = await privateRef.get();

    if (privateSnapshot.exists && valuesConflict(privateSnapshot.data(), privateData)) {
      counts.conflicts += 1;
      continue;
    }
    const effectivePrivate = { ...(privateSnapshot.data() || {}), ...privateData };
    const registrationValues = [
      ["name", player.name],
      ["uid", effectivePrivate.authUid],
      ["phone", effectivePrivate.phoneNormalized],
    ].filter(([, value]) => value);
    const keyOperations = [];
    for (const [type, value] of registrationValues) {
      const keyRef = roomRef
        .collection("playerRegistrationKeys")
        .doc(registrationKeyId(type, value));
      const keySnapshot = await keyRef.get();
      if (keySnapshot.exists && keySnapshot.data().playerId !== playerDocument.id) {
        counts.conflicts += 1;
        continue;
      }
      if (!keySnapshot.exists) {
        keyOperations.push({ keyRef, type, playerId: playerDocument.id });
      }
    }
    if (counts.conflicts > 0 && keyOperations.length !== registrationValues.length) {
      continue;
    }
    if (keyOperations.length) {
      operations.push({ type: "keys", keys: keyOperations });
      counts.registrationKeysCreated += keyOperations.length;
    }
    if (!hasPrivateFields && privateSnapshot.exists) {
      counts.unchanged += 1;
      continue;
    }
    if (!hasPrivateFields && !Object.keys(privateData).length) {
      counts.unchanged += 1;
      continue;
    }
    operations.push({
      type: "player",
      publicRef: playerDocument.ref,
      privateRef,
      privateExists: privateSnapshot.exists,
      privateData,
      publicData: publicWithoutPrivate(player),
    });
    if (privateSnapshot.exists) counts.privateUpdated += 1;
    else counts.privateCreated += 1;
    if (hasPrivateFields) counts.publicSanitized += 1;
  }

  if (counts.conflicts > 0) {
    const error = new Error("Migration conflicts require manual review");
    error.code = "migration-conflict";
    error.counts = counts;
    throw error;
  }
  if (roomSnapshot.exists) {
    const room = roomSnapshot.data();
    const sanitized = sanitizeRoomArchives(room);
    if (JSON.stringify(sanitized) !== JSON.stringify({
      gameHistory: room.gameHistory,
      prizeWheel: room.prizeWheel,
    })) {
      counts.roomArchivesSanitized = 1;
      operations.push({ type: "room", roomRef, sanitized });
    }
  }
  if (dryRun) return { dryRun: true, counts };

  for (let offset = 0; offset < operations.length; offset += 150) {
    const batch = db.batch();
    for (const operation of operations.slice(offset, offset + 150)) {
      if (operation.type === "room") {
        batch.set(operation.roomRef, operation.sanitized, { merge: true });
        continue;
      }
      if (operation.type === "keys") {
        for (const key of operation.keys) {
          batch.create(key.keyRef, {
            type: key.type,
            playerId: key.playerId,
            createdAt: now(),
          });
        }
        continue;
      }
      if (operation.type === "visitor") {
        batch.set(operation.visitorRef, operation.visitor, { merge: true });
        batch.delete(operation.publicRef);
        continue;
      }
      batch.set(
        operation.privateRef,
        {
          ...operation.privateData,
          updatedAt: now(),
          ...(!operation.privateExists ? { createdAt: now() } : {}),
        },
        { merge: true }
      );
      batch.set(operation.publicRef, operation.publicData);
    }
    await batch.commit();
  }
  return { dryRun: false, counts };
}

module.exports = {
  PRIVATE_FIELDS,
  migratePlayerPrivateData,
  normalizedPrivateData,
  publicWithoutPrivate,
  registrationKeyId,
  sanitizeRoomArchives,
  valuesConflict,
};
