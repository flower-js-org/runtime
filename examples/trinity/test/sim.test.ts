import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PROFILE, respond, SIMULATED, simulateReview, simulateTool } from "../workers/sim.ts";
import { setup } from "./support/harness.ts";

// Fast enough that the simulated waits vanish from the test.
const profile = { ...DEFAULT_PROFILE, speedup: 1e9 };
const signal = new AbortController().signal;

test("simulated turns make a random number of tool-calling stops, then answer with their simulated time", async () => {
  const t = await setup({ session: { allow: ["bash"] } });
  const stops: number[] = [];
  for (let turn = 0; turn < 30; turn++) {
    t.say(`question ${turn}`);
    let responses = 0;
    let calls = 0;
    for (;;) {
      const claim = t.claim();
      const prompt = t.prompt(claim)!;
      const response = respond(profile, "s", prompt);
      assert.deepEqual(respond(profile, "s", prompt), response, "a retried job answers the same way");
      t.reply(claim, response.blocks, response.stopReason);
      responses += 1;
      if (response.stopReason === "end_turn") break;
      for (const _ of response.blocks.filter((block) => block.type === "tool_call")) {
        const job = t.tool();
        const outcome = await simulateTool(profile, job.payload, signal);
        assert.equal(outcome.isError, false);
        t.finishTool(job, outcome.content);
        calls += 1;
      }
    }
    const reported = SIMULATED.exec(t.session().lastText ?? "");
    assert.ok(reported, "the answer reports what the turn simulated");
    assert.equal(Number(reported[1]), responses - 1);
    assert.equal(Number(reported[2]), calls);
    assert.equal(t.session().status, "idle");
    stops.push(responses - 1);
  }
  assert.ok(new Set(stops).size >= 4, `turns vary: ${stops}`);
  assert.ok(Math.max(...stops) <= DEFAULT_PROFILE.maxStops);
  const mean = stops.reduce((sum, value) => sum + value, 0) / stops.length;
  assert.ok(mean > 1 && mean < 6, `about ${DEFAULT_PROFILE.stops} stops per turn on average, got ${mean}`);
});

test("simulated latencies follow the speedup", async () => {
  const t = await setup();
  t.say("hello");
  const prompt = t.prompt(t.claim())!;
  const real = respond({ ...DEFAULT_PROFILE, speedup: 1 }, "s", prompt);
  const fast = respond({ ...DEFAULT_PROFILE, speedup: 20 }, "s", prompt);
  assert.ok(real.firstTokenMs > 200 && real.firstTokenMs < 5_000, `a real first token takes about a second, got ${real.firstTokenMs}`);
  assert.ok(Math.abs(fast.firstTokenMs * 20 - real.firstTokenMs) < 1e-6);
  assert.ok(Math.abs(fast.streamMs * 20 - real.streamMs) < 1e-6);
});

test("simulated reviews approve most calls, the same way every time", async () => {
  const job = { session: "s", step: 1, calls: Array.from({ length: 200 }, (_, index) => `c${index}`) };
  const { verdicts } = await simulateReview(profile, job, signal);
  assert.deepEqual((await simulateReview(profile, job, signal)).verdicts, verdicts);
  const approved = Object.values(verdicts).filter((verdict) => verdict.approved).length;
  assert.ok(approved > 120 && approved < 200, `most but not all calls pass, got ${approved} of 200`);
});
