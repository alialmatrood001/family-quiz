"use strict";

const { HttpsError } = require("firebase-functions/v2/https");

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function sameId(left, right) {
  return String(left || "").trim() === String(right || "").trim();
}

function validateInput(data) {
  const roomId = data?.roomId;
  const questionId = data?.questionId;
  if (typeof roomId !== "string" || !ID_PATTERN.test(roomId)) {
    throw new HttpsError("invalid-argument", "roomId must be a non-empty safe identifier");
  }
  if (typeof questionId !== "string" || !ID_PATTERN.test(questionId)) {
    throw new HttpsError("invalid-argument", "questionId must be a non-empty safe identifier");
  }
  const unexpected = Object.keys(data || {}).filter(
    (key) => !["roomId", "questionId"].includes(key)
  );
  if (unexpected.length) {
    throw new HttpsError("invalid-argument", "Only roomId and questionId are accepted");
  }
  return { roomId, questionId };
}

function requireAdmin(auth) {
  if (!auth) {
    throw new HttpsError("unauthenticated", "Authentication is required");
  }
  if (auth.token?.admin !== true) {
    throw new HttpsError("permission-denied", "Admin permission is required");
  }
}

function timestampMillis(value) {
  return value && typeof value.toMillis === "function" ? value.toMillis() : null;
}

function validateQuestion(room, questionId) {
  const question = room.currentQuestion;
  if (room.activeQuestionId && !sameId(room.activeQuestionId, questionId)) {
    throw new HttpsError("failed-precondition", "The active question id does not match the requested question");
  }
  if (!question || !sameId(question.questionId || question.id, questionId)) {
    throw new HttpsError("not-found", "The requested question is not the active room question");
  }
  if (!["question", "reveal", "results"].includes(room.stage)) {
    throw new HttpsError("failed-precondition", "The room state does not allow finalization");
  }
  const options = Array.isArray(question.options) ? question.options : [];
  const correctIndex = Number(question.correctIndex);
  const maxPoints = Number(question.maxPoints);
  const minPoints = Number(question.minPoints);
  const seconds = Number(question.seconds);
  const answerStartAtMs = Number(question.answerStartAtMs);
  const answerEndAtMs = Number(question.answerEndAtMs);
  if (
    !Number.isInteger(correctIndex) ||
    correctIndex < 0 ||
    correctIndex >= options.length ||
    !Number.isFinite(maxPoints) ||
    !Number.isFinite(minPoints) ||
    minPoints < 0 ||
    maxPoints < minPoints ||
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    !Number.isFinite(answerStartAtMs) ||
    !Number.isFinite(answerEndAtMs) ||
    answerEndAtMs < answerStartAtMs
  ) {
    throw new HttpsError("failed-precondition", "The active question is missing trusted scoring fields");
  }
  return {
    ...question,
    correctIndex,
    maxPoints,
    minPoints,
    seconds,
    answerStartAtMs,
    answerEndAtMs,
  };
}

function isVisitor(player) {
  return player.isVisitorOnly === true || String(player.id || "").startsWith("visitor-");
}

function selectOfficialAnswers(answerDocuments, questionId, playerIds) {
  const diagnostics = {
    duplicateAnswerCount: 0,
    orphanAnswerCount: 0,
    invalidAnswerCount: 0,
  };
  const candidates = [];

  for (const answer of answerDocuments) {
    if (!sameId(answer.questionId, questionId)) continue;
    if (!playerIds.has(answer.playerId)) {
      diagnostics.orphanAnswerCount += 1;
      continue;
    }
    const selectedIndex = Number(answer.selectedIndex);
    const createdAtMs = timestampMillis(answer.createdAt);
    if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || createdAtMs === null) {
      diagnostics.invalidAnswerCount += 1;
      continue;
    }
    candidates.push({ ...answer, selectedIndex, createdAtMs });
  }

  candidates.sort(
    (left, right) =>
      left.createdAtMs - right.createdAtMs || String(left.id).localeCompare(String(right.id))
  );
  const selected = new Map();
  for (const answer of candidates) {
    if (selected.has(answer.playerId)) {
      diagnostics.duplicateAnswerCount += 1;
      continue;
    }
    selected.set(answer.playerId, answer);
  }
  return { selected, diagnostics };
}

function resolveOfficialJoker(player, question, answer) {
  const practice = question.isPractice === true;
  const used = practice ? player.practiceJokerQuestionId : player.jokerQuestionId;
  const timing = practice ? player.practiceJokerTiming : player.jokerTiming;
  const multiplier = Number(
    practice ? player.practiceJokerMultiplier : player.jokerMultiplier
  );
  const lockedAt = practice ? player.practiceJokerLockedAt : player.jokerLockedAt;
  const lockedAtMs = timestampMillis(lockedAt);
  const markedUsed = practice ? Boolean(used) : player.jokerUsed === true;

  if (!markedUsed || !sameId(used, question.questionId || question.id) || lockedAtMs === null) {
    return { applied: false, multiplier: null, invalid: false };
  }
  const expectedMultiplier = timing === "before" ? 3 : timing === "during" ? 2 : null;
  const timingValid =
    timing === "before"
      ? lockedAtMs <= question.answerStartAtMs
      : timing === "during"
        ? lockedAtMs >= question.answerStartAtMs &&
          (!answer || lockedAtMs <= answer.createdAtMs)
        : false;
  if (![2, 3].includes(multiplier) || multiplier !== expectedMultiplier || !timingValid) {
    return { applied: false, multiplier: null, invalid: true };
  }
  return { applied: true, multiplier, invalid: false };
}

function sortLeaderboard(items) {
  return [...items].sort(
    (left, right) =>
      Number(right.score || 0) - Number(left.score || 0) ||
      String(left.id).localeCompare(String(right.id))
  );
}

function publicPlayerDisplayName(player) {
  return String(player?.publicDisplayName || player?.displayName || player?.name || "").trim();
}

module.exports = {
  isVisitor,
  requireAdmin,
  publicPlayerDisplayName,
  resolveOfficialJoker,
  selectOfficialAnswers,
  sortLeaderboard,
  validateInput,
  validateQuestion,
};
