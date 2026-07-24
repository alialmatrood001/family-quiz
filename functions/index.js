const { setGlobalOptions } = require("firebase-functions");
const { onRequest, onCall } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { createFinalizeQuestionHandler } = require("./finalize-question/handler");
const { createSecureWriteHandlers } = require("./secure-writes/handlers");

initializeApp();
setGlobalOptions({ maxInstances: 10 });

exports.testFunction = onRequest((request, response) => {
  response.json({
    ok: true,
    message: "Cloud Functions تعمل بنجاح",
    time: new Date().toISOString(),
  });
});

exports.finalizeQuestion = onCall(
  createFinalizeQuestionHandler({ db: getFirestore() })
);

const secureWrites = createSecureWriteHandlers({ db: getFirestore() });
exports.registerPlayer = onCall(secureWrites.registerPlayer);
exports.recoverPlayer = onCall(secureWrites.recoverPlayer);
exports.submitAnswer = onCall(secureWrites.submitAnswer);
exports.activateJoker = onCall(secureWrites.activateJoker);
exports.cancelJoker = onCall(secureWrites.cancelJoker);
exports.prepareQuestion = onCall(secureWrites.prepareQuestion);
exports.startQuestion = onCall(secureWrites.startQuestion);
exports.controlQuestion = onCall(secureWrites.controlQuestion);
exports.adjustPlayerScore = onCall(secureWrites.adjustPlayerScore);
exports.getPlayerPrivateDetails = onCall(secureWrites.getPlayerPrivateDetails);
exports.updatePlayerProfile = onCall(secureWrites.updatePlayerProfile);
exports.deletePlayer = onCall(secureWrites.deletePlayer);
exports.resetPracticeScores = onCall(secureWrites.resetPracticeScores);
exports.resetQuizData = onCall(secureWrites.resetQuizData);
