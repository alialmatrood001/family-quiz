export const PLAYER_ID_STORAGE_KEY = "familyQuizPlayerId";
export const PLAYER_AUTH_UID_STORAGE_KEY = "familyQuizPlayerAuthUid";

export function readStoredPlayerSession(storage) {
  return Object.freeze({
    playerId: String(storage?.getItem?.(PLAYER_ID_STORAGE_KEY) || "").trim(),
    authUid: String(storage?.getItem?.(PLAYER_AUTH_UID_STORAGE_KEY) || "").trim(),
  });
}

export function writeStoredPlayerSession(storage, { playerId, authUid }) {
  const safePlayerId = String(playerId || "").trim();
  const safeAuthUid = String(authUid || "").trim();
  if (!safePlayerId || !safeAuthUid) {
    throw new Error("A complete authenticated player session is required");
  }
  storage.setItem(PLAYER_ID_STORAGE_KEY, safePlayerId);
  storage.setItem(PLAYER_AUTH_UID_STORAGE_KEY, safeAuthUid);
}

export async function restoreAuthenticatedPlayerSession({
  authenticatedUser,
  storedSession,
  readPublicPlayer,
  recoverPlayer,
}) {
  const uid = String(authenticatedUser?.uid || "").trim();
  if (!uid) throw Object.assign(new Error("Authentication is required"), { code: "unauthenticated" });

  if (
    storedSession?.playerId &&
    storedSession?.authUid === uid
  ) {
    const player = await readPublicPlayer(storedSession.playerId);
    if (player) {
      return {
        status: "current-session",
        playerId: storedSession.playerId,
        player,
      };
    }
  }

  const recovered = await recoverPlayer();
  if (!recovered?.playerId) {
    throw Object.assign(new Error("Player recovery returned an invalid response"), {
      code: "invalid-response",
    });
  }
  return { ...recovered, status: recovered.status || "recovered" };
}
