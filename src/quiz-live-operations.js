import {
  controlQuizLifecycleSecurely,
  finishQuizSecurely,
  resetQuizDataSecurely,
  resetPracticeScoresSecurely,
} from "./admin-player-actions-client.js";
import {
  controlQuestionSecurely,
  prepareQuestionSecurely,
  startQuestionSecurely,
} from "./question-control-client.js";
import { createQuizLiveOperations } from "./quiz-live-operations-core.js";

export const quizLiveOperations = createQuizLiveOperations({
  controlLifecycle: controlQuizLifecycleSecurely,
  finishQuiz: finishQuizSecurely,
  resetQuizData: resetQuizDataSecurely,
  resetPracticeScores: resetPracticeScoresSecurely,
  prepareQuestion: prepareQuestionSecurely,
  startQuestion: startQuestionSecurely,
  controlQuestion: controlQuestionSecurely,
});
