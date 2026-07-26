"use strict";

function asFirebaseCallable(operation) {
  return (request) =>
    operation({
      auth: request.auth,
      data: request.data,
    });
}

module.exports = { asFirebaseCallable };
