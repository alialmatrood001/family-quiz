import { createActionEndpoint } from "./_lib/http.js";

export default createActionEndpoint({
  actions: [
    "adjustPlayerScore",
    "getPlayerPrivateDetails",
    "updatePlayerProfile",
    "deletePlayer",
    "resetPracticeScores",
    "resetQuizData",
  ],
  adminOnly: true,
});
