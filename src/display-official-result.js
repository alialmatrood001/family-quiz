import { useEffect, useMemo, useState } from "react";
import { publicPlayerDisplayName } from "./quiz-state-machine.js";

export const DISPLAY_RESULT_FALLBACK_MS = 1_500;

function sameId(left, right) {
  return String(left || "") === String(right || "");
}

export function isDisplayResultSnapshot(snapshot, questionId) {
  return (
    sameId(snapshot?.questionId, questionId) &&
    Array.isArray(snapshot?.leaderboardBefore) &&
    Array.isArray(snapshot?.leaderboardAfter)
  );
}

export function buildDisplaySnapshotFromOfficialResult({
  questionId,
  officialResult,
  players = [],
} = {}) {
  if (
    !questionId ||
    !sameId(officialResult?.questionId, questionId) ||
    !Array.isArray(officialResult?.results)
  ) return null;

  const publicPlayers = new Map(
    players.map((player) => [String(player?.id || ""), player]),
  );
  const snapshotPlayer = (result, score, before = false) => {
    const player = publicPlayers.get(String(result.playerId)) || {};
    return {
      id: result.playerId,
      name: publicPlayerDisplayName(player),
      emoji: player.emoji || "",
      score: Number(score || 0),
      jokerUsed: player.jokerUsed || result.jokerApplied || false,
      jokerQuestionId: player.jokerQuestionId || (result.jokerApplied ? questionId : null),
      jokerMultiplier: player.jokerMultiplier || result.jokerMultiplier || null,
      lastQuestionId: before ? null : questionId,
      lastQuestionPoints: before ? 0 : Number(result.points || 0),
      lastQuestionCorrect: before ? null : result.isCorrect ?? null,
    };
  };

  const leaderboardBefore = officialResult.results
    .map((result) => snapshotPlayer(result, result.scoreBefore, true))
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0));
  const leaderboardAfter = officialResult.results
    .map((result) => snapshotPlayer(result, result.scoreAfter))
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0));

  return {
    questionId,
    leaderboardBefore,
    leaderboardAfter,
    bonusByPlayer: Object.fromEntries(
      officialResult.results.map((result) => [result.playerId, Number(result.points || 0)]),
    ),
    correctByPlayer: Object.fromEntries(
      officialResult.results
        .filter((result) => result.answered)
        .map((result) => [result.playerId, result.isCorrect === true]),
    ),
    answeredByPlayer: Object.fromEntries(
      officialResult.results
        .filter((result) => result.answered)
        .map((result) => [result.playerId, true]),
    ),
    rankMovementByPlayer: Object.fromEntries(
      officialResult.results.map((result) => [result.playerId, Number(result.rankMovement || 0)]),
    ),
    calculatedAtMs: Number(officialResult.finalizedAtMs || 0),
    source: "official-result",
  };
}

export function resolveDisplayResult({ room, players, officialResultState } = {}) {
  const questionId = room?.currentQuestion?.questionId || room?.currentQuestion?.id || "";
  if (isDisplayResultSnapshot(room?.resultsDisplaySnapshot, questionId)) {
    return { status: "ready", snapshot: room.resultsDisplaySnapshot, source: "room" };
  }
  const officialSnapshot = buildDisplaySnapshotFromOfficialResult({
    questionId,
    officialResult: officialResultState?.exists ? officialResultState.result : null,
    players,
  });
  if (officialSnapshot) {
    return { status: "ready", snapshot: officialSnapshot, source: "official-result" };
  }
  if (officialResultState?.fallbackComplete === true) {
    return { status: "missing", snapshot: null, source: null };
  }
  return { status: "loading", snapshot: null, source: null };
}

export function useDisplayOfficialResult({
  enabled,
  questionId,
  listenerState,
  readResult,
  fallbackDelayMs = DISPLAY_RESULT_FALLBACK_MS,
} = {}) {
  const [fallback, setFallback] = useState({
    questionId: "",
    complete: false,
    exists: false,
    result: null,
  });
  const safeQuestionId = String(questionId || "");
  const listenerMatches = String(listenerState?.questionId || "") === safeQuestionId;
  const listenerHasCanonicalResult =
    listenerMatches &&
    listenerState?.exists === true &&
    sameId(listenerState?.result?.questionId, safeQuestionId);

  useEffect(() => {
    if (!enabled || !safeQuestionId || listenerHasCanonicalResult) {
      setFallback({ questionId: safeQuestionId, complete: false, exists: false, result: null });
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const result = await readResult(safeQuestionId);
        if (!cancelled) {
          setFallback({
            questionId: safeQuestionId,
            complete: true,
            exists: result?.exists === true,
            result: result?.exists === true ? result.result : null,
          });
        }
      } catch {
        if (!cancelled) {
          setFallback({ questionId: safeQuestionId, complete: true, exists: false, result: null });
        }
      }
    }, Math.max(0, Number(fallbackDelayMs) || 0));
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, fallbackDelayMs, listenerHasCanonicalResult, readResult, safeQuestionId]);

  return useMemo(() => {
    if (!enabled || !safeQuestionId) {
      return { questionId: safeQuestionId, loading: false, exists: false, result: null, fallbackComplete: false };
    }
    if (listenerHasCanonicalResult) {
      return { ...listenerState, fallbackComplete: false };
    }
    if (fallback.questionId === safeQuestionId && fallback.exists) {
      return {
        questionId: safeQuestionId,
        loading: false,
        exists: true,
        result: fallback.result,
        fallbackComplete: true,
      };
    }
    return {
      questionId: safeQuestionId,
      loading: true,
      exists: false,
      result: null,
      fallbackComplete: fallback.questionId === safeQuestionId && fallback.complete,
    };
  }, [enabled, fallback, listenerHasCanonicalResult, listenerState, safeQuestionId]);
}

export function DisplayOfficialResultController({
  room,
  players,
  listenerState,
  readResult,
  fallbackDelayMs,
  render,
}) {
  const questionId = room?.currentQuestion?.questionId || room?.currentQuestion?.id || "";
  const roomHasDisplaySnapshot = isDisplayResultSnapshot(room?.resultsDisplaySnapshot, questionId);
  const officialResultState = useDisplayOfficialResult({
    enabled: room?.stage === "results" && !roomHasDisplaySnapshot,
    questionId,
    listenerState,
    readResult,
    fallbackDelayMs,
  });
  return render({
    officialResultState,
    displayResult: resolveDisplayResult({ room, players, officialResultState }),
  });
}
