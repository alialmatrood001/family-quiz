import { createActionEndpoint } from "./_lib/http.js";

export default createActionEndpoint({
  actions: [
    "prepareQuestion",
    "startCompetitionWithQuestion",
    "startQuestion",
    "controlQuestion",
    "finalizeQuestion",
  ],
  adminOnly: true,
});
