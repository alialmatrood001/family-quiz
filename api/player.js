import { createActionEndpoint } from "./_lib/http.js";

export default createActionEndpoint({
  actions: [
    "registerPlayer",
    "recoverPlayer",
    "submitAnswer",
    "activateJoker",
    "cancelJoker",
    "updatePlayerProfile",
  ],
});
