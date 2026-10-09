import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseOptions,
  runValidation,
  writeEvidence
} from "./validate-live.mjs";

export function nearestRank(values, percentile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1)];
}

export function distribution(values) {
  const finite = values.filter(
    (value) => typeof value === "number" && Number.isFinite(value)
  );
  return {
    n: finite.length,
    min: finite.length ? Math.min(...finite) : null,
    median: nearestRank(finite, 50),
    p95: nearestRank(finite, 95),
    max: finite.length ? Math.max(...finite) : null
  };
}

export function summarize(samples) {
  const passed = samples.filter((sample) => sample.ok);
  const completed = samples.filter((sample) => sample.result !== null);
  const statusCounts = {};
  for (const sample of completed)
    statusCounts[sample.result.status] =
      (statusCounts[sample.result.status] ?? 0) + 1;
  return {
    attempted: samples.length,
    validationPassed: passed.length,
    validationFailed: samples.length - passed.length,
    observedValidationPassRate: samples.length
      ? passed.length / samples.length
      : null,
    workflowCompleted: completed.length,
    auditStatusCounts: statusCounts,
    percentiles:
      "Nearest rank: sort samples; x[ceil(p*n)-1]. At n=3, p95 is the maximum, not a stable tail-latency estimate.",
    latencyPopulation:
      "All completed audits, including audits whose later follow-up/reconnect/cleanup validation failed. Uncompleted/timeouts remain in samples and failure counts; no latency is fabricated for them.",
    auditCompleteMs: distribution(
      completed.map((sample) => sample.metrics.auditCompleteMs)
    ),
    firstRunningStateMs: distribution(
      completed.map((sample) => sample.metrics.firstRunningStateMs)
    ),
    serverAuditWallMs: distribution(
      completed.map((sample) => sample.metrics.serverAuditWallMs)
    ),
    originResponseMs: distribution(
      completed.map((sample) => sample.metrics.originResponseMs)
    ),
    reconnectRecoveryMs: distribution(
      samples.map((sample) => sample.metrics.reconnectRecoveryMs)
    )
  };
}

async function main() {
  const args = process.argv.slice(2);
  const countIndex = args.indexOf("--samples");
  const count = countIndex < 0 ? 3 : Number(args[countIndex + 1]);
  if (!Number.isInteger(count) || count < 1 || count > 10)
    throw new Error(
      "--samples must be an integer from 1 to 10; this harness deliberately limits origin load"
    );
  if (countIndex >= 0) args.splice(countIndex, 2);
  const options = parseOptions(args);
  if (options.keepRoom)
    throw new Error(
      "Benchmark always clears its disposable rooms; --keep-room is not supported"
    );
  const output = options.output ?? "evidence/benchmark-latest.json";
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    completedAt: null,
    host: options.host,
    protocol: options.protocol,
    auditUrl: options.auditUrl,
    deploymentLabel: options.deploymentLabel,
    design: {
      sampleCount: count,
      concurrency: 1,
      warmupRuns: 0,
      intervalBetweenRunsMs: 1000,
      isolatedRoomPerSample: true,
      originRequests:
        "One audit per sample; redirects may add HTTP requests. No recursive crawling or load test.",
      limits:
        "Small synthetic end-to-end demonstration. Not production SLA, uptime, load capacity, or proof of 25% improvement. No controlled before/after comparison."
    },
    samples: [],
    summary: null
  };
  for (let i = 0; i < count; i++) {
    console.error(`Sample ${i + 1}/${count}: ${options.auditUrl}`);
    const sample = await runValidation({
      ...options,
      room: `benchmark-${crypto.randomUUID()}`
    });
    report.samples.push({ sample: i + 1, ...sample });
    report.summary = summarize(report.samples);
    // Save after each run, including failures, so interrupted runs retain raw evidence.
    await writeEvidence(output, report);
    console.error(
      `Sample ${i + 1}: ${sample.ok ? "PASS" : "FAIL"}; status=${sample.result?.status ?? "none"}; auditCompleteMs=${sample.metrics.auditCompleteMs ?? "missing"}${sample.error ? `; ${sample.error}` : ""}`
    );
    if (i < count - 1)
      await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  report.completedAt = new Date().toISOString();
  await writeEvidence(output, report);
  console.log(JSON.stringify(report.summary, null, 2));
  if (report.summary.validationFailed > 0) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
