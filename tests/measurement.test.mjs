import test from "node:test";
import assert from "node:assert/strict";
import { distribution, summarize } from "../scripts/benchmark.mjs";
import { parseOptions, withTimeout } from "../scripts/validate-live.mjs";

test("nearest-rank p95 of three observations is the maximum; missing values are not zero", () => {
  assert.deepEqual(distribution([null, 30, 10, 20, undefined, NaN]), {
    n: 3,
    min: 10,
    median: 20,
    p95: 30,
    max: 30
  });
  assert.deepEqual(distribution([]), {
    n: 0,
    min: null,
    median: null,
    p95: null,
    max: null
  });
});

test("failed validation stays in denominator, and a later failure cannot hide completed latency", () => {
  const summary = summarize([
    {
      ok: true,
      result: { status: "partial" },
      metrics: { auditCompleteMs: 100 }
    },
    {
      ok: false,
      result: { status: "partial" },
      metrics: { auditCompleteMs: 500 }
    },
    { ok: false, result: null, metrics: {} }
  ]);
  assert.equal(summary.attempted, 3);
  assert.equal(summary.validationFailed, 2);
  assert.equal(summary.observedValidationPassRate, 1 / 3);
  assert.equal(summary.workflowCompleted, 2);
  assert.deepEqual(summary.auditStatusCounts, { partial: 2 });
  assert.equal(summary.auditCompleteMs.n, 2);
  assert.equal(summary.auditCompleteMs.p95, 500);
});

test("local test options preserve explicit target, invalid-url expectation and transport", () => {
  const options = parseOptions([
    "http://",
    "--host",
    "127.0.0.1:5173",
    "--protocol",
    "ws",
    "--skip-running-guard",
    "--expect-status",
    "invalid_url"
  ]);
  assert.equal(options.host, "127.0.0.1:5173");
  assert.equal(options.protocol, "ws");
  assert.equal(options.auditUrl, "http://");
  assert.equal(options.expectedStatus, "invalid_url");
  assert.equal(options.skipRunningGuard, true);
  assert.throws(
    () => parseOptions(["--host", "https://example.com"]),
    /hostname/
  );
  assert.throws(() => parseOptions(["--unknown"]), /Unknown option/);
});

test("bounded operation reports timeout while completed operation returns its value", async () => {
  assert.equal(
    await withTimeout(Promise.resolve("complete"), 100, "test"),
    "complete"
  );
  await assert.rejects(
    withTimeout(new Promise(() => {}), 5, "stalled RPC"),
    /stalled RPC timed out/
  );
});
