import {
  controlQuizLifecycleSecurely,
  finishQuizSecurely,
  resetAndOpenRegistrationSecurely,
  resetPracticeScoresSecurely,
} from "./admin-player-actions-client.js";
import {
  controlQuestionSecurely,
  prepareQuestionSecurely,
  startCompetitionWithQuestionSecurely,
  startQuestionSecurely,
} from "./question-control-client.js";
import { createQuizLiveOperations } from "./quiz-live-operations-core.js";

export const quizLiveOperations = createQuizLiveOperations({
  controlLifecycle: controlQuizLifecycleSecurely,
  finishQuiz: finishQuizSecurely,
  resetAndOpenRegistration: resetAndOpenRegistrationSecurely,
  resetPracticeScores: resetPracticeScoresSecurely,
  prepareQuestion: prepareQuestionSecurely,
  startCompetitionWithQuestion: startCompetitionWithQuestionSecurely,
  startQuestion: startQuestionSecurely,
  controlQuestion: controlQuestionSecurely,
});
