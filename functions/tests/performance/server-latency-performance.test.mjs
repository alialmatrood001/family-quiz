import { performance } from "node:perf_hooks";
import test from "node:test";

const OPERATIONS = Object.freeze({
  health: 0,
  submitAnswer: 1,
  controlQuestion: 2,
  finalizeQuestion: 3,
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function measure(callback) {
  const startedAt = performance.now();
  await callback();
  return Number((performance.now() - startedAt).toFixed(2));
}

async function scenario(count, concurrent, operationDelayMs) {
  const before = () => measure(async () => {
    await wait(2);
    await wait(operationDelayMs);
    await wait(1);
  });
  let warmed = false;
  const after = () => measure(async () => {
    if (!warmed) {
      warmed = true;
      await wait(2);
    }
    await wait(operationDelayMs);
  });
  const run = async (factory) => {
    const startedAt = performance.now();
    if (concurrent) await Promise.all(Array.from({ length: count }, factory));
    else for (let index = 0; index < count; index += 1) await factory();
    return Number((performance.now() - startedAt).toFixed(2));
  };
  return { before: await run(before), after: await run(after) };
}

test("diagnostic comparison: fresh client lifecycle versus warm reuse", async (context) => {
  const measurements = [];
  for (const [operation, delay] of Object.entries(OPERATIONS)) {
    for (const spec of [
      { label: "1 sequential", count: 1, concurrent: false },
      { label: "5 sequential", count: 5, concurrent: false },
      { label: "10 sequential", count: 10, concurrent: false },
      { label: "10 concurrent", count: 10, concurrent: true },
    ]) {
      const result = await scenario(spec.count, spec.concurrent, delay);
      measurements.push({ operation, scenario: spec.label, ...result });
    }
  }
  context.diagnostic(JSON.stringify(measurements));
});
