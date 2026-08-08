function sameId(left, right) {
  return String(left || "") === String(right || "");
}

function officialRow(officialResult, questionId, playerId) {
  if (!sameId(officialResult?.questionId, questionId) || !Array.isArray(officialResult?.results)) {
    return null;
  }
  return officialResult.results.find((row) => sameId(row?.playerId, playerId)) || null;
}

export function resolvePlayerQuestionResult({
  playerId,
  questionId,
  officialResultState,
  roomSnapshot,
  confirmedAnswer,
  localAnswerLock,
} = {}) {
  const result = officialRow(
    officialResultState?.exists === true ? officialResultState.result : null,
    questionId,
    playerId,
  );
  if (result) {
    return {
      status: "ready",
      source: "official-result",
      answered: result.answered === true,
      selectedIndex: result.selectedIndex ?? null,
      isCorrect: result.isCorrect ?? null,
      basePoints: Number(result.basePoints || 0),
      points: Number(result.awardedPoints ?? result.points ?? 0),
      jokerApplied: result.jokerApplied === true,
      jokerMultiplier: Number(result.jokerMultiplier || 1),
      rank: result.rank ?? result.rankAfter ?? null,
      rankMovement: Number(result.rankMovement || 0),
      responseTimeMs: Number(result.responseTimeMs || 0) || null,
    };
  }

  const snapshotMatches = sameId(roomSnapshot?.questionId, questionId);
  const snapshotAnswered = snapshotMatches && roomSnapshot?.answeredByPlayer?.[playerId] === true;
  if (snapshotAnswered) {
    const points = Number(roomSnapshot?.bonusByPlayer?.[playerId] || 0);
    return {
      status: "ready",
      source: "room-snapshot",
      answered: true,
      selectedIndex: confirmedAnswer?.selectedIndex ?? localAnswerLock?.selectedIndex ?? null,
      isCorrect: roomSnapshot?.correctByPlayer?.[playerId] === true,
      basePoints: points,
      points,
      jokerApplied: false,
      jokerMultiplier: 1,
      rank: null,
      rankMovement: Number(roomSnapshot?.rankMovementByPlayer?.[playerId] || 0),
      responseTimeMs: null,
    };
  }

  if (officialResultState?.loading === true || confirmedAnswer || localAnswerLock) {
    return { status: "loading", source: confirmedAnswer ? "confirmed-answer" : "local-lock", answered: true };
  }

  if (officialResultState?.exists === true) {
    return { status: "ready", source: "official-result", answered: false, points: 0 };
  }

  if (snapshotMatches && officialResultState?.loading === false) {
    return { status: "ready", source: "room-snapshot", answered: false, points: 0 };
  }

  return { status: "loading", source: null, answered: false };
}

export function createUiSingleFlightGate() {
  let busy = false;
  return {
    tryStart() {
      if (busy) return false;
      busy = true;
      return true;
    },
    finish() {
      busy = false;
    },
    isBusy() {
      return busy;
    },
  };
}

export function percentile(values, fraction) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}
