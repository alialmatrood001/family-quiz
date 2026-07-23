const { setGlobalOptions } = require("firebase-functions");
const { onRequest, onCall } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { createFinalizeQuestionHandler } = require("./finalize-question/handler");

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
