import { AgentClient } from "agents/client";
import WS from "ws";
import {
  parseOptions,
  runValidation,
  sendChatTurn,
  sourceRevision,
  withTimeout,
  writeEvidence
} from "./validate-live.mjs";

// These checks intentionally exercise rejected protocol messages in one new room.
const options = parseOptions([
  "--host",
  "127.0.0.1:5173",
  "--protocol",
  "ws",
  ...process.argv.slice(2)
]);
const evidence = {
  startedAt: new Date().toISOString(),
  host: options.host,
  room: options.room,
  deploymentLabel: options.deploymentLabel,
  harnessSourceRevision: sourceRevision(),
  ok: false,
  checks: {},
  events: []
};
const clients = [];
const waits = new AbortController();
let ownsDisposableRoom = false;
let dispatched = false;
const transcriptUrl = `${options.protocol === "ws" ? "http" : "https"}://${options.host}/agents/audit-agent/${options.room}/get-messages`;
async function transcript() {
  const response = await fetch(transcriptUrl, {
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Transcript HTTP ${response.status}`);
  return response.json();
}
function connect(label) {
  const client = new AgentClient({
    host: options.host,
    protocol: options.protocol,
    agent: options.agent,
    name: options.room,
    WebSocket: WS
  });
  client.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (
        [
          "cf_agent_state",
          "cf_agent_state_error",
          "cf_agent_chat_clear",
          "audit-session-error"
        ].includes(payload.type)
      ) {
        evidence.events.push({
          label,
          at: new Date().toISOString(),
          ...payload
        });
      }
    } catch {
      /* Non-JSON transport frame. */
    }
  });
  clients.push(client);
  return client;
}
function frame(client, predicate) {
  let listener;
  let abortListener;
  const pending = new Promise((resolve, reject) => {
    abortListener = () => reject(new Error("Validation finished"));
    waits.signal.addEventListener("abort", abortListener, { once: true });
    listener = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (predicate(payload)) resolve(payload);
      } catch {
        /* Ignore unrelated frames. */
      }
    };
    client.addEventListener("message", listener);
  });
  const result = withTimeout(
    pending,
    options.timeoutMs,
    "Protocol frame"
  ).finally(() => {
    client.removeEventListener("message", listener);
    waits.signal.removeEventListener("abort", abortListener);
  });
  // Concurrent completion subscription must also be safe on an earlier assertion failure.
  result.catch(() => {});
  return result;
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
try {
  const active = connect("active");
  const observer = connect("observer");
  await Promise.all(
    clients.map((client) => withTimeout(client.ready, 15000, "Connection"))
  );
  assert(
    (await active.stub.getLatestAuditResult()) === null,
    "Requires a new disposable room"
  );
  assert(
    (await transcript()).length === 0,
    "Requires an empty chat transcript"
  );
  ownsDisposableRoom = true;
  dispatched = true;
  await sendChatTurn(
    active,
    [
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: "What can I do?" }]
      }
    ],
    {},
    "seed",
    15000
  );
  const running = frame(
    active,
    (event) =>
      event.type === "cf_agent_state" && event.state?.runState === "running"
  );
  const completed = frame(
    observer,
    (event) =>
      event.type === "cf_agent_state" && event.state?.runState === "complete"
  );
  const started = active.stub.startAudit(options.auditUrl);
  const runningFrame = await running;

  const clearError = frame(
    active,
    (event) => event.type === "audit-session-error"
  );
  active.send(JSON.stringify({ type: "cf_agent_chat_clear" }));
  const clearReply = await clearError;
  assert(
    /cannot clear.*running/i.test(clearReply.message),
    "Raw chat-clear did not report running guard"
  );
  evidence.checks.rawChatClearRejectedWhileRunning = true;

  const stateError = frame(
    active,
    (event) => event.type === "cf_agent_state_error"
  );
  active.setState({
    ...runningFrame.state,
    runState: "idle",
    activeRunId: null,
    progress: 0
  });
  const stateReply = await stateError;
  assert(
    /state update rejected|controlled by the server/i.test(stateReply.error),
    "Forged state change did not report server ownership"
  );
  evidence.checks.clientCannotOverwriteServerState = true;

  const [{ runId }, finalFrame] = await Promise.all([started, completed]);
  assert(
    finalFrame.state.lastCompletedRunId === runId,
    "Original workflow did not complete"
  );
  assert(
    (await observer.stub.getLatestAuditResult())?.runId === runId,
    "Observer could not recover original result"
  );
  const observerStates = evidence.events
    .filter(
      (event) => event.label === "observer" && event.type === "cf_agent_state"
    )
    .map((event) => event.state);
  const firstRunning = observerStates.findIndex(
    (state) => state.runState === "running"
  );
  assert(
    firstRunning >= 0 &&
      !observerStates
        .slice(firstRunning)
        .some((state) => state.runState === "idle"),
    "Protocol bypass reset the observer's state during the audit"
  );
  evidence.checks.rejectedFramesDoNotCancelWorkflow = true;

  const savedTranscript = await transcript();
  assert(savedTranscript.length >= 2, "Missing seeded transcript");
  const occupiedAttempt = await runValidation({
    ...options,
    skipRunningGuard: true
  });
  assert(
    !occupiedAttempt.ok && !occupiedAttempt.cleanup.ownsDisposableRoom,
    "Occupied room should be rejected without ownership"
  );
  assert(
    (await observer.stub.getLatestAuditResult())?.runId === runId,
    "Rejected validator deleted the existing audit"
  );
  assert(
    JSON.stringify(await transcript()) === JSON.stringify(savedTranscript),
    "Rejected validator deleted the existing chat"
  );
  evidence.checks.validatorPreservesExistingRoom = true;
  evidence.occupiedRoomAttempt = {
    error: occupiedAttempt.error,
    cleanup: occupiedAttempt.cleanup
  };

  const activeClear = frame(
    active,
    (event) => event.type === "cf_agent_chat_clear"
  );
  const observerClear = frame(
    observer,
    (event) => event.type === "cf_agent_chat_clear"
  );
  await active.stub.clearAuditSession();
  await Promise.all([activeClear, observerClear]);
  assert(
    (await observer.stub.getLatestAuditResult()) === null,
    "Observer retained cleared audit"
  );
  evidence.checks.clearBroadcastReachesCallerAndOtherConnection = true;
  evidence.ok = true;
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
  if (ownsDisposableRoom && dispatched) {
    try {
      await withTimeout(clients[0].stub.clearAuditSession(), 15000, "Cleanup");
    } catch (cleanupError) {
      evidence.cleanupError = String(cleanupError);
    }
  }
} finally {
  waits.abort();
  clients.forEach((client) => client.close());
  evidence.completedAt = new Date().toISOString();
}
await writeEvidence(options.output, evidence);
console.log(JSON.stringify(evidence, null, 2));
if (!evidence.ok) process.exitCode = 1;
