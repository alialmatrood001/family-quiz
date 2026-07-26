import { createActionEndpoint } from "./_lib/http.js";

export default createActionEndpoint({
  actions: [
    "prepareQuestion",
    "startQuestion",
    "controlQuestion",
    "finalizeQuestion",
  ],
  adminOnly: true,
});
