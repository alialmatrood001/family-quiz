export function createQuizLiveOperations({
  controlLifecycle,
  finishQuiz,
  resetAndOpenRegistration,
  resetPracticeScores,
  prepareQuestion,
  startCompetitionWithQuestion,
  startQuestion,
  controlQuestion,
}) {
  return Object.freeze({
    openRegistration: (roomId) => controlLifecycle({ roomId, action: "open-registration" }),
    resetAndOpenRegistration: (roomId) => resetAndOpenRegistration({ roomId }),
    returnRegistration: (roomId) => controlLifecycle({ roomId, action: "return-registration" }),
    showInstructions: (roomId) => controlLifecycle({ roomId, action: "show-instructions" }),
    startCompetition: (roomId) => controlLifecycle({ roomId, action: "start-competition" }),
    startCompetitionWithQuestion: ({ roomId, questionId, questionIndex, selectedCategory }) =>
      startCompetitionWithQuestion({
        roomId,
        questionId,
        questionIndex,
        ...(selectedCategory ? { selectedCategory } : {}),
      }),
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
