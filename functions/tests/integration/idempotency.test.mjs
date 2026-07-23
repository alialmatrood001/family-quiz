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

test("concurrent and sequential repeats do not apply points twice", { timeout: 30_000 }, async (t) => {
  const scenario = buildScenario({
    roomId: "baseline-idempotency",
    playerCount: 12,
    correctCount: 8,
    wrongCount: 2,
  });
  t.after(() => deleteRoom(scenario.roomId));
  await writeScenario(scenario);

  const startedAt = performance.now();
  const concurrent = await Promise.all([
    callFinalizeQuestion(scenario),
    callFinalizeQuestion(scenario),
  ]);
  emitMetric("idempotency_concurrent_pair", performance.now() - startedAt);

  const successes = concurrent.filter((result) => result.success === true);
  const skips = concurrent.filter(
    (result) => result.skipped === true && result.reason === "already-processed-or-busy"
  );
  assert.equal(successes.length, 1);
  assert.equal(skips.length, 1);

  const afterConcurrent = await readState(scenario.roomId);
  const scoresAfterConcurrent = Object.fromEntries(
    afterConcurrent.players.map((player) => [player.id, player.score])
  );
  const snapshotAfterConcurrent = afterConcurrent.room.resultsDisplaySnapshot;

  const sequential = await callFinalizeQuestion(scenario);
  assert.deepEqual(sequential, {
    success: false,
    skipped: true,
    reason: "already-processed-or-busy",
  });

  const afterSequential = await readState(scenario.roomId);
  assert.deepEqual(
    Object.fromEntries(afterSequential.players.map((player) => [player.id, player.score])),
    scoresAfterConcurrent
  );
  assert.deepEqual(afterSequential.room.resultsDisplaySnapshot, snapshotAfterConcurrent);
});
