import { useMemo, useRef, useState } from "react";
import { quizLiveOperations } from "./quiz-live-operations.js";

export const PRESENTER_DEFERRED_CONTROLS = Object.freeze([
  "category-vote",
  "reopen-reveal",
  "admin-poll",
  "prize-wheel",
]);

function questionId(question) {
  return question?.questionId || question?.id || null;
}

export function getPresenterControlDescriptors({
  room,
  mainQuestions = [],
  practiceQuestions = [],
  playersCount = 0,
  isMedia = false,
  mediaEnded = true,
  isVotingQuestion = () => false,
  finalizationBusy = false,
}) {
  const stage = room?.stage || "home";
  const currentIndex = Number(room?.currentQuestionIndex ?? -1);
  const activeQuestions = room?.practiceMode ? practiceQuestions : mainQuestions;
  const current = room?.currentQuestion || null;
  const next = activeQuestions[currentIndex + 1] || null;
  const firstPractice = practiceQuestions[0] || null;
  const firstMain = mainQuestions[0] || null;
  const controls = [];

  const add = (id, label, options = {}) => controls.push({ id, label, ...options });
  const startDisabled = playersCount === 0;

  if (stage === "home") {
    add("open-registration", "فتح التسجيل", { primary: true });
  } else if (stage === "registration") {
    if (room?.practiceFinished) {
      add("start-competition", "ابدأ المسابقة", {
        primary: true,
        disabled: startDisabled || !firstMain || isVotingQuestion(firstMain),
      });
    } else {
      add("show-instructions", "عرض معلومات المسابقة", {
        primary: true,
        disabled: startDisabled,
      });
    }
  } else if (stage === "instructions") {
    if (firstPractice && !isVotingQuestion(firstPractice)) {
      add("start-practice", "بدء الأسئلة التجريبية", { disabled: startDisabled });
    }
    if (firstMain && !isVotingQuestion(firstMain)) {
      add("start-competition", "بدء المسابقة الفعلية", {
        primary: true,
        disabled: startDisabled,
      });
    }
  } else if (stage === "practiceComplete") {
    add("start-competition", "ابدأ المسابقة الفعلية", {
      primary: true,
      disabled: startDisabled || !firstMain || isVotingQuestion(firstMain),
    });
  } else if (stage === "ready") {
    add("start-question", "بدء السؤال الآن", {
      primary: true,
      disabled: !questionId(current),
    });
  } else if (stage === "question") {
    add("reveal-question", "إنهاء السؤال وإظهار الإجابة", {
      primary: true,
      disabled: !questionId(current),
    });
    add("extend-question", "+10 ثوانٍ", { disabled: !questionId(current) });
    if (isMedia && !mediaEnded) {
      add("finish-media", "تجاوز المقطع وإظهار الخيارات", { disabled: !questionId(current) });
    }
  } else if (stage === "reveal") {
    const isLast = currentIndex >= 0 && currentIndex >= activeQuestions.length - 1;
    add(isLast && !room?.practiceMode ? "announce-winners" : "finalize-question", isLast && !room?.practiceMode
      ? "اعتماد النتائج وإعلان الفائزين"
      : "اعتماد وإظهار النتائج", {
      primary: true,
      disabled: finalizationBusy || !questionId(current),
    });
  } else if (stage === "results") {
    if (next && !isVotingQuestion(next)) {
      const isLastNext = currentIndex + 1 >= activeQuestions.length - 1;
      add("prepare-next-question", isLastNext ? "السؤال الأخير" : "السؤال التالي", { primary: true });
    } else if (!next && room?.practiceMode) {
      add("finish-practice", "إنهاء التجربة", { primary: true });
    } else if (!next) {
      add("finish-quiz", "إنهاء المسابقة", { primary: true });
    }
  }

  return controls;
}

export function usePresenterQuizControls({
  room,
  mainQuestions = [],
  practiceQuestions = [],
  playersCount = 0,
  finalization,
  isVotingQuestion = () => false,
  isMediaQuestion = () => false,
  hasMediaEnded = () => true,
  operations = quizLiveOperations,
  roomId = "family-quiz-001",
}) {
  const [busyAction, setBusyAction] = useState(null);
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  const current = room?.currentQuestion || null;
  const currentId = questionId(current);
  const currentIndex = Number(room?.currentQuestionIndex ?? -1);
  const activeQuestions = room?.practiceMode ? practiceQuestions : mainQuestions;
  const nextQuestion = activeQuestions[currentIndex + 1] || null;

  const descriptors = useMemo(() => getPresenterControlDescriptors({
    room,
    mainQuestions,
    practiceQuestions,
    playersCount,
    isMedia: isMediaQuestion(current),
    mediaEnded: hasMediaEnded(room, current),
    isVotingQuestion,
    finalizationBusy: finalization?.isBusy === true,
  }), [
    room,
    mainQuestions,
    practiceQuestions,
    playersCount,
    current,
    finalization?.isBusy,
    isVotingQuestion,
    isMediaQuestion,
    hasMediaEnded,
  ]);

  async function prepare(question, index) {
    const id = questionId(question);
    if (!id || isVotingQuestion(question)) {
      throw Object.assign(new Error("هذا النوع من الانتقال مؤجل حتى يتوفر له مسار خادمي آمن."), {
        code: "deferred-control",
      });
    }
    return operations.prepareQuestion({ roomId, questionId: id, questionIndex: index });
  }

  const handlers = {
    "open-registration": () => operations.resetAndOpenRegistration(roomId),
    "show-instructions": () => operations.showInstructions(roomId),
    "start-practice": async () => {
      await operations.startPractice(roomId);
      await prepare(practiceQuestions[0], 0);
    },
    "start-competition": async () => {
      await operations.startCompetition(roomId);
      await prepare(mainQuestions[0], 0);
    },
    "start-question": () => operations.startQuestion({ roomId, questionId: currentId }),
    "reveal-question": async () => {
      if (isMediaQuestion(current) && !hasMediaEnded(room, current)) {
        await operations.finishMedia({ roomId, questionId: currentId });
      }
      await operations.revealQuestion({ roomId, questionId: currentId });
    },
    "extend-question": () => operations.extendQuestion({ roomId, questionId: currentId, seconds: 10 }),
    "finish-media": () => operations.finishMedia({ roomId, questionId: currentId }),
    "finalize-question": () => finalization.requestFinalization(),
    "announce-winners": async () => {
      await finalization.requestFinalization();
      await operations.beginFinalCountdown(roomId);
    },
    "prepare-next-question": () => prepare(nextQuestion, currentIndex + 1),
    "finish-practice": () => operations.finishPractice(roomId),
    "finish-quiz": () => operations.finishQuiz(roomId),
  };

  async function execute(actionId) {
    if (busyRef.current || !handlers[actionId]) return false;
    busyRef.current = true;
    setBusyAction(actionId);
    setError("");
    try {
      await handlers[actionId]();
      return true;
    } catch (actionError) {
      setError(actionError?.code === "deferred-control"
        ? actionError.message
        : "تعذر تنفيذ الإجراء. تحقق من حالة المسابقة ثم حاول مرة أخرى.");
      return false;
    } finally {
      busyRef.current = false;
      setBusyAction(null);
    }
  }

  return { controls: descriptors, busyAction, error, execute };
}
