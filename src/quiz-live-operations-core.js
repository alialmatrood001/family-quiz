export function createQuizLiveOperations({
  controlLifecycle,
  finishQuiz,
  resetQuizData,
  resetPracticeScores,
  prepareQuestion,
  startQuestion,
  controlQuestion,
}) {
  return Object.freeze({
    openRegistration: (roomId) => controlLifecycle({ roomId, action: "open-registration" }),
    resetAndOpenRegistration: async (roomId) => {
      await resetQuizData({
        roomId,
        mode: "full",
        reason: "فتح التسجيل من أدوات التحكم الآمنة",
      });
      return controlLifecycle({ roomId, action: "open-registration" });
    },
    returnRegistration: (roomId) => controlLifecycle({ roomId, action: "return-registration" }),
    showInstructions: (roomId) => controlLifecycle({ roomId, action: "show-instructions" }),
    startCompetition: (roomId) => controlLifecycle({ roomId, action: "start-competition" }),
    startPractice: (roomId) => controlLifecycle({ roomId, action: "start-practice" }),
    beginFinalCountdown: (roomId) => controlLifecycle({ roomId, action: "begin-final-countdown" }),
    finishQuiz: (roomId) => finishQuiz({ roomId }),
    finishPractice: (roomId) => resetPracticeScores({
      roomId,
      reason: "إنهاء الجولة التدريبية من أدوات التحكم الآمنة",
    }),
    prepareQuestion: ({ roomId, questionId, questionIndex, selectedCategory }) => prepareQuestion({
      roomId,
      questionId,
      questionIndex,
      ...(selectedCategory ? { selectedCategory } : {}),
    }),
    startQuestion: ({ roomId, questionId }) => startQuestion({ roomId, questionId }),
    revealQuestion: ({ roomId, questionId }) => controlQuestion({
      roomId,
      questionId,
      action: "reveal",
    }),
    extendQuestion: ({ roomId, questionId, seconds = 10 }) => controlQuestion({
      roomId,
      questionId,
      action: "extend",
      seconds,
    }),
    startMedia: ({ roomId, questionId }) => controlQuestion({
      roomId,
      questionId,
      action: "media-start",
    }),
    finishMedia: ({ roomId, questionId }) => controlQuestion({
      roomId,
      questionId,
      action: "media-finish",
    }),
  });
}
