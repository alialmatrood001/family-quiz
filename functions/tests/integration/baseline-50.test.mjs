import assert from "node:assert/strict";
import test from "node:test";
import {
  callFinalizeQuestion,
  deleteRoom,
  emitMetric,
  playerMap,
  readState,
  writeScenario,
} from "../helpers/emulator.mjs";
import { buildScenario, expectedScoreByPlayer } from "../fixtures/scenarios.mjs";

for (let run = 1; run <= 3; run += 1) {
  test(`50-player deterministic baseline run ${run}/3`, { timeout: 30_000 }, async (t) => {
    const scenario = buildScenario({ roomId: `baseline-50-run-${run}` });
    const expectedScores = expectedScoreByPlayer(scenario);
    t.after(() => deleteRoom(scenario.roomId));
    const fixtureTimings = await writeScenario(scenario);
    emitMetric(`baseline_50_players_create_run_${run}`, fixtureTimings.playersMs);
    emitMetric(`baseline_50_answers_create_run_${run}`, fixtureTimings.answersMs);

    const before = await readState(scenario.roomId);
    const startedAt = performance.now();
    const result = await callFinalizeQuestion(scenario);
    const elapsed = performance.now() - startedAt;
    emitMetric(`baseline_50_run_${run}`, elapsed);
    const after = await readState(scenario.roomId);
    const playersAfter = playerMap(after.players);

    assert.deepEqual(result, { success: true, skipped: false });
    assert.equal(after.room.stage, "results");
    assert.equal(after.room.processedQuestionId, scenario.questionId);
    assert.equal(after.room.currentQuestion.resultsCalculated, true);
    assert.deepEqual(after.room.unrelatedSentinel, before.room.unrelatedSentinel);
    assert.equal(after.players.length, 50);
    assert.equal(after.answers.length, 45);

    for (const originalPlayer of scenario.players) {
      const actual = playersAfter.get(originalPlayer.id);
      assert.ok(actual, `player was not lost: ${originalPlayer.id}`);
      assert.equal(actual.score, expectedScores.get(originalPlayer.id));
      assert.equal(actual.unrelatedPlayerField, originalPlayer.unrelatedPlayerField);
    }

    const results = after.room.questionResultsById[scenario.questionId];
    assert.equal(results.answersCount, 45);
    assert.equal(results.correctCount, 35);
    assert.equal(Object.keys(results.answeredByPlayer).length, 45);
    assert.equal(after.room.resultsDisplaySnapshot.leaderboardBefore.length, 50);
    assert.equal(after.room.resultsDisplaySnapshot.leaderboardAfter.length, 50);
    assert.equal(new Set(after.room.resultsDisplaySnapshot.leaderboardAfter.map((p) => p.id)).size, 50);

    const wrongWithX3 = scenario.answers.find(
      (answer) => !answer.isCorrect && answer.jokerApplied && answer.jokerMultiplier === 3
    );
    assert.ok(wrongWithX3, "fixture includes a wrong x3 joker answer");
    assert.ok(wrongWithX3.points < 0);
    assert.equal(playersAfter.get(wrongWithX3.playerId).lastQuestionPoints, wrongWithX3.points);

    const expectedOrder = [...after.players]
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
      .map((player) => player.id);
    assert.deepEqual(
      after.room.resultsDisplaySnapshot.leaderboardAfter.map((player) => player.id),
      expectedOrder
    );
  });
}
