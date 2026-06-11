const { setGlobalOptions } = require("firebase-functions");
const { onRequest, onCall } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();
setGlobalOptions({ maxInstances: 10 });

// ─── Constants (must match App.jsx) ───────────────────────────────────────────
const ROOM_ID = "family-quiz-001";
const RESULTS_PROCESSING_STALE_MS = 9000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isSameId(a, b) {
  if (!a || !b) return false;
  return String(a).trim() === String(b).trim();
}

function isVisitorRecord(item) {
  return !!item?.isVisitorOnly || String(item?.id || "").startsWith("visitor-");
}

function getJokerTimingLabel(multiplier) {
  return Number(multiplier) === 2 ? "x2" : "x3";
}

// ─── Existing test function ────────────────────────────────────────────────────
exports.testFunction = onRequest((request, response) => {
  response.json({
    ok: true,
    message: "Cloud Functions تعمل بنجاح",
    time: new Date().toISOString(),
  });
});

// ─── finalizeQuestion ─────────────────────────────────────────────────────────
//
// Callable Cloud Function that runs result calculation server-side.
// Mirrors calculateResultsForCurrentQuestion() in App.jsx exactly.
//
// Input:  { roomId?: string, questionId: string, nextStage?: "results" | null }
// Output: { success: true } | { success: false, skipped: true, reason: string }
//
// The function uses a Firestore transaction as a distributed lock so concurrent
// calls (e.g. button double-click or race between client and server) are safe.
// ─────────────────────────────────────────────────────────────────────────────
exports.finalizeQuestion = onCall(async (request) => {
  const db = getFirestore();
  const {
    roomId = ROOM_ID,
    questionId,
    nextStage = "results",
  } = request.data;

  if (!questionId) {
    throw new Error("questionId is required");
  }

  const roomRef = db.doc(`rooms/${roomId}`);

  // ── Step 1: Claim the processing lock with a transaction ──────────────────
  // This is equivalent to claimQuestionProcessing() on the frontend.
  const claimed = await db.runTransaction(async (transaction) => {
    const roomSnap = await transaction.get(roomRef);
    const roomData = roomSnap.exists ? roomSnap.data() : {};

    const alreadyProcessed =
      isSameId(roomData.processedQuestionId, questionId) ||
      roomData.currentQuestion?.resultsCalculated === true ||
      (roomData.resultsCalculated === true &&
        isSameId(roomData.resultsCalculatedQuestionId, questionId));

    const processingSameQuestion = isSameId(roomData.processingQuestionId, questionId);
    const processingStartedAt = Number(roomData.processingStartedAtMs || 0);
    const processingIsFresh =
      processingSameQuestion &&
      processingStartedAt &&
      Date.now() - processingStartedAt <= RESULTS_PROCESSING_STALE_MS;

    if (alreadyProcessed || processingIsFresh) {
      return false;
    }

    transaction.set(
      roomRef,
      {
        processingQuestionId: questionId,
        processingStartedAtMs: Date.now(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return true;
  });

  if (!claimed) {
    return { success: false, skipped: true, reason: "already-processed-or-busy" };
  }

  try {
    // ── Step 2: Read room data + answers + players in parallel ──────────────
    const [roomSnap, answersSnap, playersSnap] = await Promise.all([
      roomRef.get(),
      db
        .collection(`rooms/${roomId}/answers`)
        .where("questionId", "==", questionId)
        .get(),
      db.collection(`rooms/${roomId}/players`).get(),
    ]);

    const roomData = roomSnap.exists ? roomSnap.data() : {};

    const safeAnswers = answersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const safePlayers = playersSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((p) => !isVisitorRecord(p));

    // ── Step 3: Handle ignored question (admin marked it to skip scoring) ───
    if (roomData.questionIgnored) {
      await roomRef.update({
        processedQuestionId: questionId,
        resultsCalculated: true,
        resultsCalculatedQuestionId: questionId,
        "currentQuestion.resultsCalculated": true,
        "currentQuestion.resultsCalculatedAt": FieldValue.serverTimestamp(),
        questionResultsById: {
          [questionId]: {
            questionId,
            ignored: true,
            answersCount: 0,
            calculatedAtMs: Date.now(),
          },
        },
        collectingBonusByPlayer: {},
        collectingBonusJokerByPlayer: {},
        collectingBonusPlayerId: null,
        collectingBonusPoints: 0,
        rankMovementByPlayer: {},
        collectingAnswerCorrectByPlayer: {},
        resultsAnimationPhase: "done",
        processingQuestionId: null,
        processingStartedAtMs: null,
        resultsError: null,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { success: true, skipped: false, ignored: true };
    }

    // ── Step 4: Build per-player answer maps ────────────────────────────────
    // Sort by answeredAt so ordering is deterministic (matches frontend).
    const answersToProcess = [...safeAnswers]
      .filter((a) => a && a.playerId)
      .sort((a, b) => Number(a.answeredAt || 0) - Number(b.answeredAt || 0));

    const answerByPlayer = new Map(answersToProcess.map((a) => [a.playerId, a]));
    const bonusByPlayer = {};   // { playerId: points }  — already joker-adjusted
    const jokerByPlayer = {};   // { playerId: "x2"|"x3" }  — display only
    const correctByPlayer = {}; // { playerId: bool }

    answersToProcess.forEach((answer) => {
      // answer.points already has joker multiplier applied by the frontend when saved.
      bonusByPlayer[answer.playerId] = Number(answer.points || 0);
      correctByPlayer[answer.playerId] = !!answer.isCorrect;
      if (answer.jokerApplied) {
        jokerByPlayer[answer.playerId] = getJokerTimingLabel(answer.jokerMultiplier || 3);
      }
    });

    // ── Step 5: Snapshot leaderboard BEFORE applying new points ─────────────
    const sortedBefore = [...safePlayers].sort(
      (a, b) => Number(b.score || 0) - Number(a.score || 0)
    );
    const previousRankByPlayer = {};
    sortedBefore.forEach((p, i) => {
      previousRankByPlayer[p.id] = i + 1;
    });

    // ── Step 6: Compute each player's updated score ──────────────────────────
    const playerUpdates = safePlayers.map((player) => {
      const answer = answerByPlayer.get(player.id);
      const points = Number(answer?.points || 0);
      // Guard against double-application: if lastQuestionId already matches,
      // the points were applied in a previous run — keep existing score.
      const alreadyApplied = isSameId(player.lastQuestionId, questionId);
      const nextScore = alreadyApplied
        ? Number(player.score || 0)
        : Number(player.score || 0) + points;
      return { player, answer, points, alreadyApplied, nextScore };
    });

    // ── Step 7: Batch-write player score updates ─────────────────────────────
    const scoresBatch = db.batch();
    playerUpdates.forEach(({ player, answer, points, alreadyApplied, nextScore }) => {
      const playerRef = db.doc(`rooms/${roomId}/players/${player.id}`);
      const update = {
        score: nextScore,
        answeredCount:
          Number(player.answeredCount || 0) + (!alreadyApplied && answer ? 1 : 0),
        lastQuestionPoints: points,
        lastQuestionId: questionId,
        lastQuestionCorrect: answer ? !!answer.isCorrect : null,
        // Only update lastAnswerAt when the player actually answered this question.
        lastAnswerAt: answer
          ? FieldValue.serverTimestamp()
          : player.lastAnswerAt || null,
      };
      scoresBatch.update(playerRef, update);
    });
    await scoresBatch.commit();

    // ── Step 8: Build leaderboard snapshots for the results animation ────────
    const sortedAfterRaw = [...playerUpdates]
      .map(({ player, nextScore }) => ({ player, nextScore }))
      .sort((a, b) => Number(b.nextScore || 0) - Number(a.nextScore || 0));

    const rankMovementByPlayer = {};
    sortedAfterRaw.forEach(({ player }, i) => {
      rankMovementByPlayer[player.id] =
        (previousRankByPlayer[player.id] || i + 1) - (i + 1);
    });

    const leaderboardBeforeSnapshot = sortedBefore.map((p) => ({
      id: p.id,
      name: p.name || "",
      emoji: p.emoji || "",
      score: Number(p.score || 0),
      jokerUsed: p.jokerUsed || false,
      jokerQuestionId: p.jokerQuestionId || null,
      jokerMultiplier: p.jokerMultiplier || null,
      lastQuestionId: p.lastQuestionId || null,
      lastQuestionPoints: Number(p.lastQuestionPoints || 0),
      lastQuestionCorrect: p.lastQuestionCorrect ?? null,
    }));

    const leaderboardAfterSnapshot = sortedAfterRaw.map(({ player, nextScore }) => ({
      id: player.id,
      name: player.name || "",
      emoji: player.emoji || "",
      score: nextScore,
      jokerUsed: player.jokerUsed || false,
      jokerQuestionId: player.jokerQuestionId || null,
      jokerMultiplier: player.jokerMultiplier || null,
      lastQuestionId: questionId,
      lastQuestionPoints: Number(bonusByPlayer[player.id] || 0),
      lastQuestionCorrect: correctByPlayer[player.id] ?? null,
    }));

    // ── Step 9: Write result snapshot + clear lock ───────────────────────────
    const roomUpdate = {
      processedQuestionId: questionId,
      resultsCalculated: true,
      resultsCalculatedQuestionId: questionId,
      "currentQuestion.resultsCalculated": true,
      "currentQuestion.resultsCalculatedAt": FieldValue.serverTimestamp(),
      questionResultsById: {
        [questionId]: {
          questionId,
          answersCount: answersToProcess.length,
          correctCount: answersToProcess.filter((a) => a.isCorrect).length,
          jokerCount: answersToProcess.filter((a) => a.jokerApplied).length,
          bonusByPlayer,
          jokerByPlayer,
          correctByPlayer,
          rankMovementByPlayer,
          calculatedAtMs: Date.now(),
        },
      },
      collectingBonusByPlayer: bonusByPlayer,
      collectingBonusJokerByPlayer: jokerByPlayer,
      collectingBonusPlayerId: null,
      collectingBonusPoints: 0,
      rankMovementByPlayer,
      collectingAnswerCorrectByPlayer: correctByPlayer,
      resultsAnimationPhase: "done",
      resultsDisplaySnapshot: {
        questionId,
        leaderboardBefore: leaderboardBeforeSnapshot,
        leaderboardAfter: leaderboardAfterSnapshot,
        bonusByPlayer,
        correctByPlayer,
        rankMovementByPlayer,
        calculatedAtMs: Date.now(),
      },
      calculationStatus: "calculated",
      processingQuestionId: null,
      processingStartedAtMs: null,
      resultsError: null,
      updatedAt: FieldValue.serverTimestamp(),
    };

    // Only set stage if requested (nextStage: null means caller handles it).
    if (nextStage) {
      roomUpdate.stage = nextStage;
    }

    await roomRef.update(roomUpdate);
    return { success: true, skipped: false };

  } catch (error) {
    // Release the lock so the admin can retry.
    await roomRef
      .update({
        resultsError: String(error?.message || error),
        processingQuestionId: null,
        processingStartedAtMs: null,
        updatedAt: FieldValue.serverTimestamp(),
      })
      .catch(() => {}); // best-effort — don't mask the original error

    throw error;
  }
});
