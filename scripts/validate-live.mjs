import { AgentClient } from "agents/client";
import WS from "ws";

const HOST =
  process.env.AGENT_HOST ?? "cf-ai-edge-inspector.zheng-jiaju.workers.dev";
const AGENT = process.env.AGENT_NAME ?? "AuditAgent";
const ROOM = process.env.AGENT_ROOM ?? `e2e-${Date.now()}`;
const AUDIT_URL = process.env.AUDIT_URL ?? "https://example.com";

const CHAT_RESPONSE = "cf_agent_use_chat_response";
const STATE_UPDATE = "cf_agent_state";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms
      );
    })
  ]);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function extractText(message) {
  if (!message?.parts) return "";
  return message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

async function fetchMessages(room) {
  const response = await fetch(
    `https://${HOST}/agents/audit-agent/${room}/get-messages`
  );
  if (!response.ok) {
    throw new Error(
      `Failed to fetch messages for room ${room}: ${response.status} ${response.statusText}`
    );
  }
  const text = await response.text();
  return text.trim() ? JSON.parse(text) : [];
}

function createClient(room, onStateUpdate, debug) {
  const client = new AgentClient({
    host: HOST,
    protocol: "wss",
    agent: AGENT,
    name: room,
    onStateUpdate,
    WebSocket: WS
  });

  client.addEventListener("open", () => {
    debug.opened = true;
  });
  client.addEventListener("error", () => {
    debug.errors += 1;
  });
  client.addEventListener("close", (event) => {
    debug.closed = true;
    debug.closeCode = event.code;
    debug.closeReason = event.reason;
    debug.wasClean = event.wasClean;
  });

  return client;
}

async function waitForReady(client) {
  await withTimeout(client.ready, 15000, "Agent websocket identification");
}

async function waitForWorkflowCompletion(client) {
  if (client.state?.runState === "complete") {
    return client.state;
  }

  return withTimeout(
    new Promise((resolve, reject) => {
      const onMessage = (event) => {
        if (typeof event.data !== "string") return;

        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }

        if (payload.type !== STATE_UPDATE) return;

        if (payload.state?.runState === "complete") {
          client.removeEventListener("message", onMessage);
          resolve(payload.state);
          return;
        }

        if (payload.state?.runState === "error") {
          client.removeEventListener("message", onMessage);
          reject(
            new Error(
              `Workflow moved into error state: ${payload.state?.lastError ?? "unknown error"}`
            )
          );
        }
      };

      client.addEventListener("message", onMessage);
    }),
    120000,
    "Workflow completion"
  );
}

async function sendChatTurn(client, messages) {
  const requestId = crypto.randomUUID();

  return withTimeout(
    new Promise((resolve, reject) => {
      const chunks = [];

      const onMessage = (event) => {
        if (typeof event.data !== "string") return;

        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }

        if (payload.type !== CHAT_RESPONSE || payload.id !== requestId) {
          return;
        }

        if (payload.body?.trim()) {
          try {
            chunks.push(JSON.parse(payload.body));
          } catch {
            chunks.push(payload.body);
          }
        }

        if (payload.error) {
          client.removeEventListener("message", onMessage);
          reject(new Error(payload.body || "Chat stream returned an error"));
          return;
        }

        if (payload.done) {
          client.removeEventListener("message", onMessage);
          resolve({ requestId, chunks });
        }
      };

      client.addEventListener("message", onMessage);
      client.send(
        JSON.stringify({
          type: "cf_agent_use_chat_request",
          id: requestId,
          init: {
            method: "POST",
            body: JSON.stringify({
              trigger: "submit-message",
              messages
            })
          }
        })
      );
    }),
    45000,
    "Chat turn"
  );
}

async function main() {
  const stateTransitions = [];
  let firstTurn = null;
  let firstTranscript = [];
  const connectionDebug = {
    opened: false,
    closed: false,
    errors: 0,
    closeCode: null,
    closeReason: null,
    wasClean: null
  };
  const client = createClient(
    ROOM,
    (state) => {
      stateTransitions.push({
        runState: state?.runState ?? null,
        phase: state?.phase ?? null,
        progress: state?.progress ?? null
      });
    },
    connectionDebug
  );

  try {
    await waitForReady(client);

    const initialMessages = [
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: `Analyze ${AUDIT_URL}` }]
      }
    ];

    firstTurn = await sendChatTurn(client, initialMessages);
    await sleep(1500);
    firstTranscript = await fetchMessages(ROOM);

    assert(
      stateTransitions.some((entry) => entry.runState === "running"),
      "The first chat turn completed, but the agent never entered a running state."
    );

    const completedState = await waitForWorkflowCompletion(client);
    const latestAudit = await client.stub.getLatestAuditResult();

    assert(
      latestAudit,
      "Expected a persisted audit result after workflow completion."
    );
    assert(
      completedState.progress === 100,
      `Expected progress 100, received ${completedState.progress}.`
    );
    assert(
      stateTransitions.some((entry) => entry.phase === "fetching"),
      "Expected to observe a fetching phase over state sync."
    );
    assert(
      stateTransitions.some((entry) => entry.phase === "summarizing"),
      "Expected to observe a summarizing phase over state sync."
    );

    assert(
      firstTranscript.length >= 2,
      "Expected at least one user and one assistant message after the first turn."
    );

    client.close();
    await sleep(250);

    const reconnectStateTransitions = [];
    const reconnectDebug = {
      opened: false,
      closed: false,
      errors: 0,
      closeCode: null,
      closeReason: null,
      wasClean: null
    };
    const reconnected = createClient(
      ROOM,
      (state) => {
        reconnectStateTransitions.push(state);
      },
      reconnectDebug
    );

    await waitForReady(reconnected);
    await sleep(500);

    const reconnectedAudit = await reconnected.stub.getLatestAuditResult();
    assert(
      reconnectedAudit,
      "Expected the latest audit result to remain available after reconnect."
    );
    assert(
      reconnectedAudit.runId === latestAudit.runId,
      "Expected reconnect to preserve the latest audit run."
    );

    const followUpMessages = [
      ...firstTranscript,
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: "What should I fix first?" }]
      }
    ];

    await sendChatTurn(reconnected, followUpMessages);
    await sleep(1500);

    const finalTranscript = await fetchMessages(ROOM);
    const lastAssistant = [...finalTranscript]
      .reverse()
      .find((message) => message.role === "assistant");
    const lastAssistantText = extractText(lastAssistant);

    assert(
      lastAssistantText.length > 0,
      "Expected the follow-up turn to end with a textual assistant response."
    );
    assert(
      /fix|priority|recommend|first/i.test(lastAssistantText),
      "Expected the follow-up response to discuss what to fix first."
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          host: HOST,
          room: ROOM,
          auditUrl: AUDIT_URL,
          latestStatus: latestAudit.status,
          findings: latestAudit.findings.length,
          historyCount: reconnected.state?.history?.length ?? null,
          wsUrl: client.url,
          connectionDebug,
          reconnectDebug,
          stateTransitions,
          reconnectStateCount: reconnectStateTransitions.length,
          followUpPreview: lastAssistantText.slice(0, 240)
        },
        null,
        2
      )
    );

    reconnected.close();
  } catch (error) {
    let latestAudit = null;
    try {
      latestAudit = await client.stub.getLatestAuditResult();
    } catch {}

    client.close();
    console.error(
      JSON.stringify(
        {
          ok: false,
          host: HOST,
          room: ROOM,
          auditUrl: AUDIT_URL,
          wsUrl: client.url,
          connectionDebug,
          currentState: client.state ?? null,
          stateTransitions,
          latestAuditPreview: latestAudit
            ? {
                runId: latestAudit.runId,
                status: latestAudit.status,
                summary: latestAudit.summary,
                findings: latestAudit.findings?.length ?? null
              }
            : null,
          firstTurnChunks: firstTurn?.chunks?.slice(0, 20) ?? null,
          transcriptPreview: firstTranscript.slice(-4).map((message) => ({
            role: message.role,
            text: extractText(message).slice(0, 240),
            parts: message.parts?.map((part) => part.type) ?? []
          })),
          error: error instanceof Error ? error.message : String(error)
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  }
}

await main();
