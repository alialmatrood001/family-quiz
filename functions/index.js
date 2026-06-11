const { setGlobalOptions } = require("firebase-functions");
const { onRequest } = require("firebase-functions/v2/https");

setGlobalOptions({ maxInstances: 10 });

exports.testFunction = onRequest((request, response) => {
  response.json({
    ok: true,
    message: "Cloud Functions تعمل بنجاح",
    time: new Date().toISOString(),
  });
});