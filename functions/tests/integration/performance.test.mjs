import assert from "node:assert/strict";
import test from "node:test";
import {
  callFinalizeQuestion,
  deleteRoom,
  emitMetric,
  readState,
  writeScenario,
} from "../helpers/emulator.mjs";
import { buildScenario } from "../fixtures/scenarios.mjs";

test("100-player diagnostic performance run completes safely", { timeout: 60_000 }, async (t) => {
  const scenario = buildScenario({
    roomId: "baseline-performance-100",
    playerCount: 100,
    correctCount: 70,
    wrongCount: 20,
  });
  t.after(() => deleteRoom(scenario.roomId));
  const fixtureTimings = await writeScenario(scenario);
  emitMetric("performance_100_players_create", fixtureTimings.playersMs);
  emitMetric("performance_100_answers_create", fixtureTimings.answersMs);

  const startedAt = performance.now();
  const result = await callFinalizeQuestion(scenario, { timeoutMs: 45_000 });
  const elapsed = performance.now() - startedAt;
  emitMetric("performance_100_players", elapsed);

  const state = await readState(scenario.roomId);
  assert.deepEqual(result, { success: true, skipped: false });
  assert.equal(state.players.length, 100);
  assert.equal(state.answers.length, 90);
  assert.equal(state.room.resultsDisplaySnapshot.leaderboardAfter.length, 100);
  assert.ok(elapsed < 45_000, `diagnostic run exceeded the 45s callable timeout: ${elapsed}ms`);
});
