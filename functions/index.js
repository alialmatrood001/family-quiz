const { setGlobalOptions } = require("firebase-functions");
const { onRequest, onCall } = require("firebase-functions/v2/https");
const { asFirebaseCallable } = require("./server/firebase-callable");
const { getServerOperations } = require("./server/operations");

setGlobalOptions({ maxInstances: 10 });
const operations = getServerOperations();

exports.testFunction = onRequest((request, response) => {
  response.json({
    ok: true,
    message: "Cloud Functions تعمل بنجاح",
    time: new Date().toISOString(),
  });
});

exports.finalizeQuestion = onCall(
  asFirebaseCallable(operations.finalizeQuestion)
);

exports.registerPlayer = onCall(asFirebaseCallable(operations.registerPlayer));
exports.recoverPlayer = onCall(asFirebaseCallable(operations.recoverPlayer));
exports.submitAnswer = onCall(asFirebaseCallable(operations.submitAnswer));
exports.activateJoker = onCall(asFirebaseCallable(operations.activateJoker));
exports.cancelJoker = onCall(asFirebaseCallable(operations.cancelJoker));
exports.prepareQuestion = onCall(asFirebaseCallable(operations.prepareQuestion));
exports.startQuestion = onCall(asFirebaseCallable(operations.startQuestion));
exports.controlQuestion = onCall(asFirebaseCallable(operations.controlQuestion));
exports.controlQuizLifecycle = onCall(asFirebaseCallable(operations.controlQuizLifecycle));
exports.finishQuiz = onCall(asFirebaseCallable(operations.finishQuiz));
exports.adjustPlayerScore = onCall(asFirebaseCallable(operations.adjustPlayerScore));
exports.getPlayerPrivateDetails = onCall(
  asFirebaseCallable(operations.getPlayerPrivateDetails)
);
exports.initializeQuiz = onCall(asFirebaseCallable(operations.initializeQuiz));
exports.updatePlayerProfile = onCall(asFirebaseCallable(operations.updatePlayerProfile));
exports.deletePlayer = onCall(asFirebaseCallable(operations.deletePlayer));
exports.resetPracticeScores = onCall(asFirebaseCallable(operations.resetPracticeScores));
exports.resetQuizData = onCall(asFirebaseCallable(operations.resetQuizData));
