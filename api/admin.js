import { createActionEndpoint } from "./_lib/http.js";

export default createActionEndpoint({
  actions: [
    "adjustPlayerScore",
    "getPlayerPrivateDetails",
    "initializeQuiz",
    "updatePlayerProfile",
    "deletePlayer",
    "resetPracticeScores",
    "resetQuizData",
  ],
  adminOnly: true,
});
