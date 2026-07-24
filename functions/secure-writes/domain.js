"use strict";

const { HttpsError } = require("firebase-functions/v2/https");

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SCORE_DELTA_LIMIT = 10_000;

function safeId(value, fieldName) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new HttpsError("invalid-argument", `${fieldName} must be a safe identifier`);
  }
  return value;
}

function exactInput(data, required, optional = []) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpsError("invalid-argument", "Request data must be an object");
  }
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(data).some((key) => !allowed.has(key))) {
    throw new HttpsError("invalid-argument", "Unexpected request fields");
  }
  for (const key of required) {
    if (data[key] === undefined || data[key] === null) {
      throw new HttpsError("invalid-argument", `${key} is required`);
    }
  }
  return data;
}

function requireAuthenticated(auth) {
  if (!auth?.uid) {
    throw new HttpsError("unauthenticated", "Authentication is required");
  }
  return auth.uid;
}

function requireAdmin(auth) {
  const uid = requireAuthenticated(auth);
  if (auth.token?.admin !== true) {
    throw new HttpsError("permission-denied", "Admin permission is required");
  }
  return uid;
}

function requirePlayerOwner(player, auth) {
  const uid = requireAuthenticated(auth);
  if (!player || player.authUid !== uid) {
    throw new HttpsError("permission-denied", "The authenticated user does not own this player");
  }
  return uid;
}

function normalizePhone(value) {
  const phoneNormalized = String(value || "").replace(/\D/g, "");
  if (!/^\d{10}$/.test(phoneNormalized)) {
    throw new HttpsError("invalid-argument", "Phone must contain exactly 10 digits");
  }
  return phoneNormalized;
}

function normalizeRecoveryName(value) {
  const fullName = String(value || "").trim().replace(/\s+/g, " ");
  if (fullName.length < 3 || fullName.length > 100) {
    throw new HttpsError("invalid-argument", "Full name must contain 3 to 100 characters");
  }
  return {
    fullName,
    recoveryNameNormalized: fullName.toLocaleLowerCase("ar"),
  };
}

function publicPlayerData({ name, emoji, createdAt }) {
  return {
    name,
    displayName: name,
    emoji,
    score: 0,
    rank: null,
    answeredCount: 0,
    pendingJoker: false,
    jokerAvailable: true,
    jokerState: "available",
    jokerUsed: false,
    jokerQuestionId: null,
    jokerQuestionNumber: null,
    practicePendingJoker: false,
    practiceJokerQuestionId: null,
    practiceJokerTiming: null,
    practiceJokerMultiplier: null,
    active: true,
    joinedAt: createdAt,
    createdAt,
  };
}

function validateSelectedIndex(value) {
  if (!Number.isInteger(value) || value < 0 || value > 99) {
    throw new HttpsError("invalid-argument", "selectedIndex must be a valid integer");
  }
  return value;
}

function validateScoreAdjustment(data) {
  exactInput(data, ["roomId", "playerId", "delta", "reason"]);
  const roomId = safeId(data.roomId, "roomId");
  const playerId = safeId(data.playerId, "playerId");
  if (
    typeof data.delta !== "number" ||
    !Number.isFinite(data.delta) ||
    !Number.isInteger(data.delta) ||
    Math.abs(data.delta) > SCORE_DELTA_LIMIT
  ) {
    throw new HttpsError(
      "invalid-argument",
      `delta must be an integer between -${SCORE_DELTA_LIMIT} and ${SCORE_DELTA_LIMIT}`
    );
  }
  const reason = typeof data.reason === "string" ? data.reason.trim() : "";
  if (reason.length < 3 || reason.length > 200) {
    throw new HttpsError("invalid-argument", "reason must contain 3 to 200 characters");
  }
  return { roomId, playerId, delta: data.delta, reason };
}

function publicQuestionData(question, questionId, selectedCategory = null) {
  let materialized = { ...question };
  if (question.voteEnabled && Array.isArray(question.voteChoices)) {
    const choice = question.voteChoices.find((item) => item.category === selectedCategory);
    if (!choice) {
      throw new HttpsError("invalid-argument", "A valid selectedCategory is required");
    }
    materialized = {
      ...question,
      ...choice,
      voteRoundId: questionId,
      selectedVoteCategory: choice.category,
      voteEnabled: false,
    };
  }
  const correctIndex = Number(materialized.correctIndex);
  const options = Array.isArray(materialized.options) ? materialized.options : [];
  if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) {
    throw new HttpsError("failed-precondition", "Question correctIndex is invalid");
  }
  const maxPoints = Number(materialized.maxPoints);
  const minPoints = Number(materialized.minPoints);
  const seconds = Number(materialized.seconds || materialized.time);
  if (
    !Number.isFinite(maxPoints) ||
    !Number.isFinite(minPoints) ||
    minPoints < 0 ||
    maxPoints < minPoints ||
    !Number.isFinite(seconds) ||
    seconds <= 0
  ) {
    throw new HttpsError("failed-precondition", "Question scoring fields are invalid");
  }

  const safe = { ...materialized };
  delete safe.correctIndex;
  delete safe.correctOption;
  delete safe.correctOptionIndex;
  const safeVoteChoices = Array.isArray(safe.voteChoices)
    ? safe.voteChoices.map((choice) => {
        const safeChoice = { ...choice };
        delete safeChoice.correctIndex;
        delete safeChoice.correctOption;
        delete safeChoice.correctOptionIndex;
        return safeChoice;
      })
    : safe.voteChoices;

  return {
    publicQuestion: {
      ...safe,
      ...(safeVoteChoices === undefined ? {} : { voteChoices: safeVoteChoices }),
      id: questionId,
      questionId,
      seconds,
      maxPoints,
      minPoints,
      resultsCalculated: false,
      resultsCalculatedAt: null,
    },
    secret: {
      questionId,
      correctIndex,
      seconds,
      maxPoints,
      minPoints,
      isPractice: materialized.isPractice === true,
      answerRevealDelaySeconds: Number(
        materialized.answerRevealDelaySeconds ??
          materialized.revealDelaySeconds ??
          (["audio", "video", "media"].includes(materialized.type) ? 5 : 3)
      ),
      type: materialized.type || "multiple_choice",
    },
  };
}

module.exports = {
  SCORE_DELTA_LIMIT,
  exactInput,
  normalizePhone,
  normalizeRecoveryName,
  publicQuestionData,
  publicPlayerData,
  requireAdmin,
  requireAuthenticated,
  requirePlayerOwner,
  safeId,
  validateScoreAdjustment,
  validateSelectedIndex,
};
