const RESUMABLE_STAGES = new Set(["reveal", "finalizing", "results"]);
const RESUMABLE_STATES = new Set(["processing", "failed"]);

export function timestampToMillis(value) {
  if (
    (typeof value === "number" || (typeof value === "string" && value.trim())) &&
    Number.isFinite(Number(value))
  ) return Number(value);
  if (value && typeof value.toMillis === "function") {
    const milliseconds = Number(value.toMillis());
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  const seconds = Number(value?.seconds ?? value?._seconds);
  const nanoseconds = Number(value?.nanoseconds ?? value?._nanoseconds ?? 0);
  if (!Number.isFinite(seconds) || !Number.isFinite(nanoseconds)) return null;
  return seconds * 1000 + Math.floor(nanoseconds / 1_000_000);
}

export function finalizationStartedAtMs(room) {
  const numeric = Number(
    room?.finalization?.startedAtMs ?? room?.processingStartedAtMs,
  );
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return timestampToMillis(room?.finalization?.startedAt);
}

export function decideFinalizationResume({
  room,
  canFinalize,
  hookReady,
  officialResultLoading,
  officialResultExists,
  requestActive,
  attemptedQuestionId,
  nowMs = Date.now(),
} = {}) {
  const questionId = String(
    room?.currentQuestion?.questionId ||
      room?.currentQuestion?.id ||
      room?.activeQuestionId ||
      "",
  ).trim();
  const finalizationState = String(room?.finalization?.status || "");
  const startedAtMs = finalizationStartedAtMs(room);
  const lockAgeMs = startedAtMs === null ? null : Math.max(0, nowMs - startedAtMs);
  const base = { questionId, finalizationState, lockAgeMs };

  if (!canFinalize) return { ...base, shouldResume: false, reason: "admin-not-ready" };
  if (!questionId) return { ...base, shouldResume: false, reason: "question-not-ready" };
  if (!hookReady) return { ...base, shouldResume: false, reason: "hook-not-ready" };
  if (!RESUMABLE_STAGES.has(String(room?.stage || ""))) {
    return { ...base, shouldResume: false, reason: "stage-not-resumable" };
  }
  if (!RESUMABLE_STATES.has(finalizationState)) {
    return { ...base, shouldResume: false, reason: "state-not-resumable" };
  }
  if (officialResultLoading) {
    return { ...base, shouldResume: false, reason: "official-result-loading" };
  }
  if (officialResultExists || String(room?.processedQuestionId || "") === questionId) {
    return { ...base, shouldResume: false, reason: "official-result-exists" };
  }
  if (requestActive) return { ...base, shouldResume: false, reason: "request-active" };
  if (String(attemptedQuestionId || "") === questionId) {
    return { ...base, shouldResume: false, reason: "already-attempted" };
  }
  return {
    ...base,
    shouldResume: true,
    reason: finalizationState === "failed" ? "resume-failed" : "resume-processing",
  };
}

export function attemptFinalizationResume({ context, attemptedRef, request, onDecision } = {}) {
  const decision = decideFinalizationResume({
    ...context,
    attemptedQuestionId: attemptedRef?.current,
  });
  onDecision?.(decision);
  if (!decision.shouldResume) return { decision, promise: null };

  attemptedRef.current = decision.questionId;
  return {
    decision,
    promise: Promise.resolve().then(request),
  };
}
