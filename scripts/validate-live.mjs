import { AgentClient } from "agents/client";
import WS from "ws";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

export const DEFAULT_HOST = "cf-ai-edge-inspector.zheng-jiaju.workers.dev";
const CHAT_RESPONSE = "cf_agent_use_chat_response";

export function parseOptions(args = process.argv.slice(2)) {
  const options = {
    host: process.env.AGENT_HOST ?? DEFAULT_HOST,
    protocol: process.env.AGENT_PROTOCOL ?? "wss",
    agent: process.env.AGENT_NAME ?? "AuditAgent",
    room: process.env.AGENT_ROOM ?? `validation-${crypto.randomUUID()}`,
    auditUrl: process.env.AUDIT_URL ?? "https://example.com",
    timeoutMs: 120000,
    keepRoom: false,
    skipRunningGuard: false,
    skipFollowUp: false,
    checkDuplicateStart: false,
    expectedStatus: null,
    output: null,
    deploymentLabel:
      process.env.DEPLOYMENT_LABEL ?? "existing-deployment-unverified-revision"
  };
  const flags = new Map([
    ["--host", "host"],
    ["--protocol", "protocol"],
    ["--room", "room"],
    ["--output", "output"],
    ["--timeout-ms", "timeoutMs"],
    ["--deployment-label", "deploymentLabel"],
    ["--expect-status", "expectedStatus"]
  ]);
  let foundUrl = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (flags.has(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith("--"))
        throw new Error(`Missing value for ${arg}`);
      options[flags.get(arg)] = args[++i];
    } else if (arg === "--keep-room") options.keepRoom = true;
    else if (arg === "--skip-running-guard") options.skipRunningGuard = true;
    else if (arg === "--skip-followup") options.skipFollowUp = true;
    else if (arg === "--check-duplicate-start")
      options.checkDuplicateStart = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`);
    else if (!foundUrl) {
      options.auditUrl = arg;
      foundUrl = true;
    } else throw new Error(`Unexpected argument ${arg}`);
  }
  options.timeoutMs = Number(options.timeoutMs);
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000)
    throw new Error("timeout-ms must be at least 1000");
  if (!["ws", "wss"].includes(options.protocol))
    throw new Error("protocol must be ws or wss");
  if (options.host.includes("/"))
    throw new Error(
      "host must be hostname[:port], without a URL scheme or path"
    );
  if (!/^[a-zA-Z0-9_-]+$/.test(options.room))
    throw new Error(
      "room must contain letters, numbers, hyphens or underscores"
    );
  return options;
}

export async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function extractText(message) {
  return (
    message?.parts
      ?.filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim() ?? ""
  );
}
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
const round = (value) => Math.round(value * 100) / 100;

function waitForState(client, predicate, ms, label) {
  if (predicate(client.state)) return Promise.resolve(client.state);
  let onMessage;
  const pending = new Promise((resolveState, reject) => {
    onMessage = (event) => {
      if (typeof event.data !== "string") return;
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (payload.type !== "cf_agent_state") return;
      if (payload.state?.runState === "error") {
        reject(
          new Error(`Workflow error: ${payload.state.lastError ?? "unknown"}`)
        );
      } else if (predicate(payload.state)) resolveState(payload.state);
    };
    client.addEventListener("message", onMessage);
  });
  return withTimeout(pending, ms, label).finally(() =>
    client.removeEventListener("message", onMessage)
  );
}

export async function sendChatTurn(
  client,
  messages,
  metrics,
  prefix,
  timeoutMs
) {
  const id = crypto.randomUUID();
  let onMessage;
  const started = performance.now();
  try {
    return await withTimeout(
      new Promise((resolveTurn, reject) => {
        let bodyCount = 0;
        onMessage = (event) => {
          if (typeof event.data !== "string") return;
          let payload;
          try {
            payload = JSON.parse(event.data);
          } catch {
            return;
          }
          if (payload.type !== CHAT_RESPONSE || payload.id !== id) return;
          if (payload.body?.trim()) {
            bodyCount++;
            // This is the first transport body, not necessarily the first model token.
            metrics[`${prefix}FirstBodyMs`] ??= round(
              performance.now() - started
            );
          }
          if (payload.error)
            reject(new Error(payload.body || "Chat stream returned an error"));
          else if (payload.done) {
            metrics[`${prefix}DoneMs`] = round(performance.now() - started);
            resolveTurn({ id, bodyCount });
          }
        };
        client.addEventListener("message", onMessage);
        client.send(
          JSON.stringify({
            type: "cf_agent_use_chat_request",
            id,
            init: {
              method: "POST",
              body: JSON.stringify({ trigger: "submit-message", messages })
            }
          })
        );
      }),
      timeoutMs,
      `${prefix} chat`
    );
  } finally {
    client.removeEventListener("message", onMessage);
  }
}

export function sourceRevision() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8"
    }).trim();
  } catch {
    return null;
  }
}

export async function writeEvidence(path, evidence) {
  if (!path) return;
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`);
}

export async function runValidation(options) {
  const started = performance.now();
  const evidence = {
    schemaVersion: 1,
    ok: false,
    startedAt: new Date().toISOString(),
    completedAt: null,
    host: options.host,
    protocol: options.protocol,
    room: options.room,
    auditUrl: options.auditUrl,
    deploymentLabel: options.deploymentLabel,
    harnessSourceRevision: sourceRevision(),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch
    },
    measurement:
      "Client monotonic elapsed milliseconds; live WebSocket event receipt, not server CPU time or SLA.",
    progressStatusPollRequests: 0,
    metrics: {},
    checks: {},
    connections: [],
    stateTransitions: [],
    transportMessages: [],
    result: null,
    cleanup: { requested: !options.keepRoom, verified: false }
  };
  const clients = [];
  let dispatchAt = null;
  let ownsDisposableRoom = false;
  let runningGuard = null;
  let duplicateStartGuard = null;
  let currentClient;
  const rpc = (client, method, ...args) =>
    withTimeout(client.stub[method](...args), 15000, method);
  const connect = (label) => {
    const connection = { label, opened: false, errors: 0, closed: false };
    evidence.connections.push(connection);
    const client = new AgentClient({
      host: options.host,
      protocol: options.protocol,
      agent: options.agent,
      name: options.room,
      WebSocket: WS,
      onStateUpdate: (state) => {
        const atMs = round(performance.now() - started);
        evidence.stateTransitions.push({
          connection: label,
          at: new Date().toISOString(),
          atMs,
          sinceDispatchMs:
            dispatchAt === null ? null : round(performance.now() - dispatchAt),
          runState: state?.runState ?? null,
          phase: state?.phase ?? null,
          progress: state?.progress ?? null,
          activeRunId: state?.activeRunId ?? null,
          lastCompletedRunId: state?.lastCompletedRunId ?? null
        });
        if (
          label === "initial" &&
          dispatchAt !== null &&
          state?.runState === "running"
        ) {
          evidence.metrics.firstRunningStateMs ??= round(
            performance.now() - dispatchAt
          );
          if (!options.skipRunningGuard && !runningGuard && state.activeRunId) {
            runningGuard = rpc(client, "clearAuditSession").then(
              () => ({
                passed: false,
                error:
                  "Clear unexpectedly succeeded while the audit was running"
              }),
              (error) => ({
                passed: /cannot clear.*running/i.test(errorText(error)),
                error: errorText(error)
              })
            );
            if (options.checkDuplicateStart) {
              // Dispatch both guard probes from the same running event. Waiting
              // for Clear's round trip could let a short audit finish first.
              duplicateStartGuard = rpc(
                client,
                "startAudit",
                options.auditUrl
              ).then(
                () => ({
                  passed: false,
                  error: "A duplicate start unexpectedly succeeded"
                }),
                (error) => ({
                  passed: /already running|audit.*running/i.test(
                    errorText(error)
                  ),
                  error: errorText(error)
                })
              );
            }
          }
        }
        if (
          label === "initial" &&
          dispatchAt !== null &&
          state?.runState === "complete"
        ) {
          evidence.metrics.auditCompleteMs ??= round(
            performance.now() - dispatchAt
          );
        }
      }
    });
    client.addEventListener("message", (event) => {
      if (evidence.transportMessages.length >= 40) return;
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "cf_agent_state") return;
        evidence.transportMessages.push({
          connection: label,
          at: new Date().toISOString(),
          type: payload.type,
          id: payload.id ?? null,
          done: payload.done ?? null,
          error: payload.error ?? null,
          bodyPreview:
            typeof payload.body === "string" ? payload.body.slice(0, 160) : null
        });
      } catch {
        /* Ignore non-JSON frames. */
      }
    });
    client.addEventListener("open", () => {
      connection.opened = true;
    });
    client.addEventListener("error", () => {
      connection.errors++;
    });
    client.addEventListener("close", (event) => {
      connection.closed = true;
      connection.closeCode = event.code;
    });
    clients.push(client);
    currentClient = client;
    return client;
  };
  const fetchMessages = async () => {
    const scheme = options.protocol === "ws" ? "http" : "https";
    const route = options.agent
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .toLowerCase();
    const response = await fetch(
      `${scheme}://${options.host}/agents/${route}/${options.room}/get-messages`,
      { signal: AbortSignal.timeout(15000) }
    );
    if (!response.ok) throw new Error(`Transcript HTTP ${response.status}`);
    const body = await response.text();
    return body.trim() ? JSON.parse(body) : [];
  };
  try {
    const client = connect("initial");
    await withTimeout(client.ready, 15000, "Initial WebSocket identification");
    await waitForState(
      client,
      (state) => Boolean(state?.runState),
      15000,
      "Initial state"
    );
    evidence.metrics.connectionReadyMs = round(performance.now() - started);
    assert(
      client.state.runState === "idle",
      "Validation requires a new, empty room"
    );
    assert(
      (await rpc(client, "getLatestAuditResult")) === null,
      "Validation room already contains an audit"
    );
    assert(
      (await fetchMessages()).length === 0,
      "Validation room already contains chat history"
    );

    ownsDisposableRoom = true;
    dispatchAt = performance.now();
    evidence.dispatchedAt = new Date().toISOString();
    // Subscribe before sending so fast invalid-URL completion cannot be missed.
    const completed = waitForState(
      client,
      (state) => state?.runState === "complete",
      options.timeoutMs,
      "Workflow completion"
    );
    const initialTurn = sendChatTurn(
      client,
      [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: `Analyze ${options.auditUrl}` }]
        }
      ],
      evidence.metrics,
      "initialChat",
      options.timeoutMs
    );
    const [completedState] = await Promise.all([completed, initialTurn]);
    const latestAudit = await rpc(client, "getLatestAuditResult");
    assert(latestAudit, "No persisted audit after workflow completion");
    evidence.result = latestAudit;
    if (options.expectedStatus) {
      assert(
        latestAudit.status === options.expectedStatus,
        `Expected audit status ${options.expectedStatus}, received ${latestAudit.status}`
      );
      evidence.checks.expectedAuditStatus = true;
    }
    evidence.metrics.serverAuditWallMs =
      Date.parse(latestAudit.completedAt) - Date.parse(latestAudit.startedAt);
    evidence.metrics.originResponseMs = latestAudit.metadata.responseTimeMs;
    assert(completedState.progress === 100, "Completed progress must be 100");
    evidence.checks.workflowCompleted = true;
    const phases = evidence.stateTransitions
      .filter((entry) => entry.connection === "initial")
      .map((entry) => entry.phase);
    assert(
      phases.includes("validating") && phases.includes("done"),
      "Missing validating/done WebSocket phases"
    );
    if (latestAudit.status !== "invalid_url") {
      for (const phase of [
        "fetching",
        "inspecting",
        "summarizing",
        "persisting"
      ]) {
        assert(phases.includes(phase), `Missing ${phase} WebSocket phase`);
      }
    }
    evidence.checks.websocketProgress = true;
    if (!options.skipRunningGuard) {
      assert(
        runningGuard,
        "No running state available for Clear guard verification; use --skip-running-guard for a fast invalid URL case"
      );
      evidence.runningClearGuard = await runningGuard;
      assert(
        evidence.runningClearGuard.passed,
        evidence.runningClearGuard.error
      );
      evidence.checks.clearRejectedWhileRunning = true;
    } else evidence.checks.clearRejectedWhileRunning = "skipped";
    if (options.checkDuplicateStart) {
      assert(duplicateStartGuard, "Duplicate-start guard was not exercised");
      evidence.duplicateStartGuard = await duplicateStartGuard;
      assert(
        evidence.duplicateStartGuard.passed,
        evidence.duplicateStartGuard.error
      );
      evidence.checks.duplicateStartRejectedWhileRunning = true;
    }

    const transcript = await fetchMessages();
    assert(
      transcript.some((message) => message.role === "user") &&
        transcript.some((message) => message.role === "assistant"),
      "Initial chat transcript was not persisted"
    );
    evidence.checks.chatTranscriptPersisted = true;
    client.close();

    const reconnectAt = performance.now();
    const reconnected = connect("reconnect");
    await withTimeout(
      reconnected.ready,
      15000,
      "Reconnect WebSocket identification"
    );
    await waitForState(
      reconnected,
      (state) => state?.lastCompletedRunId === latestAudit.runId,
      15000,
      "Persisted state on reconnect"
    );
    const recovered = await rpc(reconnected, "getLatestAuditResult");
    assert(
      JSON.stringify(recovered) === JSON.stringify(latestAudit),
      "Full persisted audit changed after a new connection"
    );
    assert(
      JSON.stringify(await fetchMessages()) === JSON.stringify(transcript),
      "Persisted transcript changed after a new connection"
    );
    evidence.metrics.reconnectRecoveryMs = round(
      performance.now() - reconnectAt
    );
    evidence.checks.freshConnectionRecoversAuditAndChat = true;

    if (!options.skipFollowUp) {
      await sendChatTurn(
        reconnected,
        [
          ...transcript,
          {
            id: crypto.randomUUID(),
            role: "user",
            parts: [{ type: "text", text: "What should I fix first?" }]
          }
        ],
        evidence.metrics,
        "followUp",
        options.timeoutMs
      );
      const afterFollowUp = await fetchMessages();
      const answer = extractText(
        [...afterFollowUp]
          .reverse()
          .find((message) => message.role === "assistant")
      );
      assert(
        answer.length > 0 && afterFollowUp.length > transcript.length,
        "No new textual follow-up answer persisted"
      );
      assert(
        (await rpc(reconnected, "getLatestAuditResult"))?.runId ===
          latestAudit.runId,
        "Follow-up unexpectedly replaced the audit"
      );
      evidence.followUpPreview = answer.slice(0, 800);
      evidence.checks.followUpTextAndSameRun = true;
    } else evidence.checks.followUpTextAndSameRun = "skipped";

    if (!options.keepRoom) {
      const clearAt = performance.now();
      await rpc(reconnected, "clearAuditSession");
      await waitForState(
        reconnected,
        (state) =>
          state?.runState === "idle" &&
          state?.history?.length === 0 &&
          state?.latestSummary === null,
        15000,
        "Clear state broadcast"
      );
      assert(
        (await rpc(reconnected, "getLatestAuditResult")) === null,
        "Clear left audit rows"
      );
      assert((await fetchMessages()).length === 0, "Clear left chat rows");
      reconnected.close();
      const afterClear = connect("after-clear");
      await withTimeout(
        afterClear.ready,
        15000,
        "After-clear WebSocket identification"
      );
      await waitForState(
        afterClear,
        (state) => state?.runState === "idle" && state?.history?.length === 0,
        15000,
        "After-clear state"
      );
      assert(
        (await rpc(afterClear, "getLatestAuditResult")) === null,
        "New connection recovered an audit after Clear"
      );
      assert(
        (await fetchMessages()).length === 0,
        "New connection recovered chat after Clear"
      );
      evidence.metrics.clearAndVerifyMs = round(performance.now() - clearAt);
      evidence.checks.clearPersistsAcrossNewConnection = true;
      evidence.cleanup.verified = true;
    } else evidence.checks.clearPersistsAcrossNewConnection = "skipped";
    evidence.ok = true;
  } catch (error) {
    evidence.error = errorText(error);
    if (
      currentClient &&
      ownsDisposableRoom &&
      dispatchAt !== null &&
      !options.keepRoom
    ) {
      try {
        await rpc(currentClient, "clearAuditSession");
        evidence.cleanup.bestEffort = "clear-rpc-succeeded-after-failure";
      } catch (cleanupError) {
        evidence.cleanup.error = errorText(cleanupError);
      }
    }
  } finally {
    evidence.cleanup.ownsDisposableRoom = ownsDisposableRoom;
    for (const client of clients) client.close();
    evidence.completedAt = new Date().toISOString();
    evidence.metrics.validationTotalMs = round(performance.now() - started);
  }
  return evidence;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const options = parseOptions();
    const evidence = await runValidation(options);
    await writeEvidence(options.output, evidence);
    console.log(JSON.stringify(evidence, null, 2));
    if (!evidence.ok) process.exitCode = 1;
  } catch (error) {
    console.error(errorText(error));
    process.exitCode = 1;
  }
}
