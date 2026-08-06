const ACTIVE_QUESTION_STAGES = new Set(["question", "reveal"]);
const BUSY_FINALIZATION_STATES = new Set(["requesting", "processing", "recovering"]);

export const ACTIVE_QUESTION_RESET_MESSAGE =
  "لا يمكن تهيئة المسابقة أثناء وجود سؤال نشط. أنهِ السؤال أولًا.";

export function isQuizResetBlocked({ stage, finalizationStatus, serverFinalizationStatus } = {}) {
  return (
    ACTIVE_QUESTION_STAGES.has(String(stage || "")) ||
    BUSY_FINALIZATION_STATES.has(String(finalizationStatus || "")) ||
    serverFinalizationStatus === "processing"
  );
}

export function getQuizResetErrorMessage(error) {
  if (
    error?.code === "failed-precondition" ||
    error?.status === 409 ||
    /cannot be reset during an active question/i.test(String(error?.message || ""))
  ) {
    return ACTIVE_QUESTION_RESET_MESSAGE;
  }
  return "تعذر تنفيذ التهيئة. حاول مرة أخرى بعد التحقق من حالة المسابقة.";
}

export async function runQuizResetAction(action, { onError } = {}) {
  try {
    await action();
    return { ok: true };
  } catch (error) {
    const message = getQuizResetErrorMessage(error);
    onError?.(message);
    return { ok: false, error, message };
  }
}
