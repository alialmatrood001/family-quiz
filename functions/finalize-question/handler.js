"use strict";

const crypto = require("node:crypto");
const { HttpsError } = require("firebase-functions/v2/https");
const { FieldValue } = require("firebase-admin/firestore");
const { calculateQuestionPoints } = require("./calculate-points");
const {
  isVisitor,
  requireAdmin,
  resolveOfficialJoker,
  selectOfficialAnswers,
  sortLeaderboard,
  validateInput,
  validateQuestion,
} = require("./domain");

const LOCK_STALE_MS = 30_000;
const MAX_ATOMIC_PLAYERS = 400;

function safeConflictReason(error) {
  const reasons = new Map([
    ["Question finalization lock ownership was lost", "operation-lock-lost"],
    ["The active question id does not match the requested question", "active-question-id-mismatch"],
    ["The requested question is not the active room question", "active-question-mismatch"],
    ["The room state does not allow finalization", "room-stage-mismatch"],
    ["The active question is missing trusted scoring fields", "incomplete-question-snapshot"],
    ["Player state indicates a partial legacy finalization", "partial-legacy-finalization"],
  ]);
  if (reasons.has(error?.message)) return reasons.get(error.message);
  if (/Atomic finalization supports at most/.test(String(error?.message || ""))) {
    return "atomic-player-limit";
  }
  return String(error?.code || "internal").replace(/^functions\//, "");
}

function publicResult(result, status) {
  return {
    success: true,
    status,
    questionId: result.questionId,
    runId: result.runId,
    counts: result.counts,
  };
}

function createFinalizeQuestionHandler({
  db,
  now = () => Date.now(),
  runId = () => crypto.randomUUID(),
  logger = console,
}) {
  return async (request) => {
    requireAdmin(request.auth);
    const { roomId, questionId } = validateInput(request.data);
    const currentRunId = runId();
    const roomRef = db.doc(`rooms/${roomId}`);
    const resultRef = roomRef.collection("questionResults").doc(questionId);
    const secretRef = roomRef.collection("questionSecrets").doc(questionId);
    let claimed = false;

    const logFinalization = (level, finalizationState, conflictReason = null, operationId = currentRunId) => {
      const writer = typeof logger?.[level] === "function" ? logger[level].bind(logger) : null;
      writer?.("quiz-finalization", {
        action: "finalizeQuestion",
        roomId,
        questionId,
        operationId: String(operationId || currentRunId),
        finalizationState,
        conflictReason,
      });
    };

    try {
      const existingResult = await db.runTransaction(async (transaction) => {
        const roomSnapshot = await transaction.get(roomRef);
        if (!roomSnapshot.exists) {
          throw new HttpsError("not-found", "Room not found");
        }
        const room = roomSnapshot.data();
        const [resultSnapshot, secretSnapshot] = await Promise.all([
          transaction.get(resultRef),
          transaction.get(secretRef),
        ]);
        if (resultSnapshot.exists) return { type: "result", data: resultSnapshot.data() };

        const trustedRoom = secretSnapshot.exists
          ? {
              ...room,
              currentQuestion: {
                ...room.currentQuestion,
                ...secretSnapshot.data(),
              },
            }
          : room;
        validateQuestion(trustedRoom, questionId);
        const finalization = room.finalization || {};
        const startedAtMs = Number(finalization.startedAtMs || 0);
        if (
          finalization.status === "processing" &&
          finalization.questionId === questionId &&
          startedAtMs > 0 &&
          now() - startedAtMs <= LOCK_STALE_MS
        ) {
          return {
            type: "processing",
            data: {
              success: true,
              status: "processing",
              questionId,
              runId: finalization.runId || null,
            },
          };
        }
        const claimedAtMs = now();
        transaction.set(
          roomRef,
          {
            finalization: {
              status: "processing",
              questionId,
              runId: currentRunId,
              attempt: Number(finalization.attempt || 0) + 1,
              startedAt: FieldValue.serverTimestamp(),
              startedAtMs: claimedAtMs,
            },
            processingQuestionId: questionId,
            processingStartedAtMs: claimedAtMs,
            resultsError: null,
          },
          { merge: true }
        );
        return { type: "claimed", staleLockReclaimed: finalization.status === "processing" };
      });
      if (existingResult.type === "result") {
        logFinalization("info", "completed", "already-finalized", existingResult.data.runId);
        return publicResult(existingResult.data, "already-finalized");
      }
      if (existingResult.type === "processing") {
        logFinalization("info", "processing", "duplicate-request", existingResult.data.runId);
        return existingResult.data;
      }
      claimed = true;
      logFinalization(
        "info",
        "processing",
        existingResult.staleLockReclaimed ? "stale-lock-reclaimed" : null,
      );

      return await db.runTransaction(async (transaction) => {
        const roomSnapshot = await transaction.get(roomRef);
        if (!roomSnapshot.exists) {
          throw new HttpsError("not-found", "Room not found");
        }
        const room = roomSnapshot.data();
        const [resultSnapshot, secretSnapshot] = await Promise.all([
          transaction.get(resultRef),
          transaction.get(secretRef),
        ]);
        if (resultSnapshot.exists) {
          return publicResult(resultSnapshot.data(), "already-finalized");
        }

        const finalization = room.finalization || {};
        if (
          finalization.status !== "processing" ||
          finalization.questionId !== questionId ||
          finalization.runId !== currentRunId
        ) {
          throw new HttpsError("aborted", "Question finalization lock ownership was lost");
        }

        const trustedRoom = secretSnapshot.exists
          ? {
              ...room,
              currentQuestion: {
                ...room.currentQuestion,
                ...secretSnapshot.data(),
              },
            }
          : room;
        const question = validateQuestion(trustedRoom, questionId);
        const playersQuery = roomRef.collection("players");
        const answersQuery = roomRef.collection("answers").where("questionId", "==", questionId);
        const playersSnapshot = await transaction.get(playersQuery);
        const answersSnapshot = await transaction.get(answersQuery);
        const players = playersSnapshot.docs
          .map((document) => ({ id: document.id, ...document.data(), ref: document.ref }))
          .filter((player) => !isVisitor(player));

        if (players.length > MAX_ATOMIC_PLAYERS) {
          throw new HttpsError(
            "failed-precondition",
            `Atomic finalization supports at most ${MAX_ATOMIC_PLAYERS} players`
          );
        }
        if (players.some((player) => player.lastQuestionId === questionId)) {
          throw new HttpsError(
            "failed-precondition",
            "Player state indicates a partial legacy finalization"
          );
        }

        const answerDocuments = answersSnapshot.docs.map((document) => ({
          id: document.id,
          ...document.data(),
        }));
        const playerIds = new Set(players.map((player) => player.id));
        const { selected: answerByPlayer, diagnostics } = selectOfficialAnswers(
          answerDocuments,
          questionId,
          playerIds
        );

        const before = sortLeaderboard(
          players.map((player) => ({ ...player, score: Number(player.score || 0) }))
        );
        const previousRank = new Map(before.map((player, index) => [player.id, index + 1]));
        let invalidJokerCount = 0;
        const computed = players.map((player) => {
          const answer = answerByPlayer.get(player.id) || null;
          const isCorrect = Boolean(answer && answer.selectedIndex === question.correctIndex);
          const joker = resolveOfficialJoker(player, question, answer);
          if (joker.invalid) invalidJokerCount += 1;
          const scoring = answer
            ? calculateQuestionPoints({
                isCorrect,
                maxPoints: question.maxPoints,
                minPoints: question.minPoints,
                seconds: question.seconds,
                answerStartAtMs: question.answerStartAtMs,
                answeredAtMs: answer.createdAtMs,
                jokerMultiplier: joker.applied ? joker.multiplier : null,
              })
            : { basePoints: 0, points: 0 };
          return {
            player,
            answer,
            isCorrect: answer ? isCorrect : null,
            joker,
            basePoints: scoring.basePoints,
            points: scoring.points,
            score: Number(player.score || 0) + scoring.points,
          };
        });

        const after = sortLeaderboard(
          computed.map((item) => ({ ...item.player, score: item.score }))
        );
        const newRank = new Map(after.map((player, index) => [player.id, index + 1]));
        const results = computed
          .map((item) => ({
            playerId: item.player.id,
            answered: Boolean(item.answer),
            selectedIndex: item.answer?.selectedIndex ?? null,
            isCorrect: item.isCorrect,
            basePoints: item.basePoints,
            points: item.points,
            scoreBefore: Number(item.player.score || 0),
            scoreAfter: item.score,
            rankBefore: previousRank.get(item.player.id),
            rankAfter: newRank.get(item.player.id),
            rankMovement:
              previousRank.get(item.player.id) - newRank.get(item.player.id),
            jokerApplied: item.joker.applied,
            jokerMultiplier: item.joker.multiplier,
          }))
          .sort((left, right) => left.playerId.localeCompare(right.playerId));

        const counts = {
          players: players.length,
          validAnswers: answerByPlayer.size,
          correct: results.filter((item) => item.isCorrect === true).length,
          wrong: results.filter((item) => item.answered && item.isCorrect === false).length,
          unanswered: results.filter((item) => !item.answered).length,
          jokerApplied: results.filter((item) => item.jokerApplied).length,
          invalidJoker: invalidJokerCount,
          ...diagnostics,
        };
        const finalizedAtMs = now();
        const resultDocument = {
          questionId,
          runId: currentRunId,
          finalizedAt: FieldValue.serverTimestamp(),
          finalizedAtMs,
          counts,
          results,
        };

        for (const item of computed) {
          transaction.update(item.player.ref, {
            score: item.score,
            rank: newRank.get(item.player.id),
            answeredCount:
              Number(item.player.answeredCount || 0) + (item.answer ? 1 : 0),
            lastQuestionId: questionId,
            lastQuestionPoints: item.points,
            lastQuestionCorrect: item.isCorrect,
            lastAnswerAt: item.answer?.createdAt || item.player.lastAnswerAt || null,
          });
        }
        transaction.create(resultRef, resultDocument);

        const bonusByPlayer = Object.fromEntries(results.map((item) => [item.playerId, item.points]));
        const correctByPlayer = Object.fromEntries(
          results.filter((item) => item.answered).map((item) => [item.playerId, item.isCorrect])
        );
        const answeredByPlayer = Object.fromEntries(
          results.filter((item) => item.answered).map((item) => [item.playerId, true])
        );
        const rankMovementByPlayer = Object.fromEntries(
          results.map((item) => [item.playerId, item.rankMovement])
        );
        const jokerByPlayer = Object.fromEntries(
          results
            .filter((item) => item.jokerApplied)
            .map((item) => [item.playerId, `x${item.jokerMultiplier}`])
        );
        const compatibilitySummary = {
          questionId,
          answersCount: counts.validAnswers,
          correctCount: counts.correct,
          jokerCount: counts.jokerApplied,
          bonusByPlayer,
          jokerByPlayer,
          correctByPlayer,
          answeredByPlayer,
          rankMovementByPlayer,
          calculatedAtMs: finalizedAtMs,
          officialResultPath: resultRef.path,
          runId: currentRunId,
        };
        const snapshotPlayer = (player, score) => ({
          id: player.id,
          name: player.name || "",
          emoji: player.emoji || "",
          score,
          jokerUsed: player.jokerUsed || false,
          jokerQuestionId: player.jokerQuestionId || null,
          jokerMultiplier: player.jokerMultiplier || null,
          lastQuestionId: questionId,
          lastQuestionPoints:
            results.find((item) => item.playerId === player.id)?.points || 0,
          lastQuestionCorrect:
            results.find((item) => item.playerId === player.id)?.isCorrect ?? null,
        });
        const beforeById = new Map(players.map((player) => [player.id, player]));
        const afterById = new Map(computed.map((item) => [item.player.id, item]));
        transaction.set(
          roomRef,
          {
            processedQuestionId: questionId,
            resultsCalculated: true,
            resultsCalculatedQuestionId: questionId,
            currentQuestion: {
              ...question,
              resultsCalculated: true,
              resultsCalculatedAt: FieldValue.serverTimestamp(),
            },
            questionResultsById: { [questionId]: compatibilitySummary },
            collectingBonusByPlayer: bonusByPlayer,
            collectingBonusJokerByPlayer: jokerByPlayer,
            collectingBonusPlayerId: null,
            collectingBonusPoints: 0,
            rankMovementByPlayer,
            collectingAnswerCorrectByPlayer: correctByPlayer,
            resultsAnimationPhase: "done",
            resultsDisplaySnapshot: {
              questionId,
              leaderboardBefore: before.map((player) =>
                snapshotPlayer(beforeById.get(player.id), Number(player.score || 0))
              ),
              leaderboardAfter: after.map((player) =>
                snapshotPlayer(player, afterById.get(player.id).score)
              ),
              bonusByPlayer,
              correctByPlayer,
              answeredByPlayer,
              rankMovementByPlayer,
              calculatedAtMs: finalizedAtMs,
            },
            calculationStatus: "calculated",
            finalization: {
              status: "completed",
              questionId,
              runId: currentRunId,
              attempt: Number(finalization.attempt || 1),
              startedAt: finalization.startedAt || null,
              startedAtMs: Number(finalization.startedAtMs || finalizedAtMs),
              completedAt: FieldValue.serverTimestamp(),
              completedAtMs: finalizedAtMs,
            },
            processingQuestionId: null,
            processingStartedAtMs: null,
            resultsError: null,
            stage: "results",
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        const response = publicResult({ questionId, runId: currentRunId, counts }, "finalized");
        logFinalization("info", "completed");
        return response;
      });
    } catch (error) {
      if (claimed) {
        await db
          .runTransaction(async (transaction) => {
            const roomSnapshot = await transaction.get(roomRef);
            const resultSnapshot = await transaction.get(resultRef);
            if (!roomSnapshot.exists || resultSnapshot.exists) return;
            const finalization = roomSnapshot.data().finalization || {};
            if (
              finalization.status !== "processing" ||
              finalization.runId !== currentRunId
            ) {
              return;
            }
            transaction.set(
              roomRef,
              {
                finalization: {
                  ...finalization,
                  status: "failed",
                  failedAt: FieldValue.serverTimestamp(),
                  failedAtMs: now(),
                },
                processingQuestionId: null,
                processingStartedAtMs: null,
                resultsError: "finalization-failed",
              },
              { merge: true }
            );
          })
          .catch((cleanupError) => {
            logFinalization(
              "error",
              "processing",
              `cleanup-failed:${String(cleanupError?.code || "unknown")}`,
            );
          });
      }
      logFinalization(
        "error",
        claimed ? "failed" : "rejected",
        safeConflictReason(error),
      );
      if (error instanceof HttpsError) throw error;
      throw new HttpsError("internal", "Question finalization failed");
    }
  };
}

module.exports = { createFinalizeQuestionHandler, LOCK_STALE_MS, MAX_ATOMIC_PLAYERS };
