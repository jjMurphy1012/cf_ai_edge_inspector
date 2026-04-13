import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool,
  type ModelMessage
} from "ai";
import { z } from "zod";
import type {
  AuditResult,
  AgentState,
  HistoryEntry,
  StartAuditParams
} from "./types";
export { WebsiteAuditWorkflow } from "./workflow";

const MAX_HISTORY_ITEMS = 5;
const SUMMARY_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const INITIAL_STATE: AgentState = {
  runState: "idle",
  phase: "idle",
  progress: 0,
  currentUrl: null,
  activeRunId: null,
  lastCompletedRunId: null,
  lastError: null,
  latestSummary: null,
  history: []
};

type AuditRow = {
  run_id: string;
  url: string;
  normalized_url: string | null;
  status: AuditResult["status"];
  summary: string;
  recommendations_json: string;
  findings_json: string;
  metadata_json: string;
  started_at: string;
  completed_at: string;
};

type AuditHistorySummary = {
  runId: string;
  url: string;
  status: AuditResult["status"];
  summary: string;
  completedAt: string;
};

/**
 * The AI SDK's downloadAssets step runs `new URL(data)` on every file
 * part's string data. Data URIs parse as valid URLs, so it tries to
 * HTTP-fetch them and fails. Decode to Uint8Array so the SDK treats
 * them as inline data instead.
 */
function inlineDataUrls(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "user" || typeof msg.content === "string") return msg;
    return {
      ...msg,
      content: msg.content.map((part) => {
        if (part.type !== "file" || typeof part.data !== "string") return part;
        const match = part.data.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) return part;
        const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
        return { ...part, data: bytes, mediaType: match[1] };
      })
    };
  });
}

export class AuditAgent extends AIChatAgent<Env, AgentState> {
  initialState = INITIAL_STATE;
  maxPersistedMessages = 100;

  onStart() {
    this.ensureAuditTable();
    const latestAudit = this.getLatestAudit();
    const history = this.getRecentHistory();

    if (
      this.state.history.length === 0 &&
      history.length > 0 &&
      this.state.runState === "idle"
    ) {
      this.setState({
        ...this.state,
        history,
        latestSummary: latestAudit?.summary ?? null,
        lastCompletedRunId: latestAudit?.runId ?? null
      });
    }

    // Configure OAuth popup behavior for MCP servers that require authentication
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });
  }

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  @callable()
  async getLatestAuditResult() {
    return this.getLatestAudit();
  }

  private ensureAuditTable() {
    this.sql`
      CREATE TABLE IF NOT EXISTS audit_runs (
        run_id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        normalized_url TEXT,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        recommendations_json TEXT NOT NULL,
        findings_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL
      )
    `;
  }

  private getRecentHistory(limit = MAX_HISTORY_ITEMS): HistoryEntry[] {
    const rows = this.sql<{
      run_id: string;
      url: string;
      status: AuditResult["status"];
      summary: string;
      completed_at: string;
    }>`
      SELECT run_id, url, status, summary, completed_at
      FROM audit_runs
      ORDER BY completed_at DESC
      LIMIT ${limit}
    `;

    return rows.map((row) => ({
      runId: row.run_id,
      url: row.url,
      status: row.status,
      summary: row.summary,
      completedAt: row.completed_at
    }));
  }

  private compareRecentAudits():
    | {
        latest: AuditHistorySummary;
        previous: AuditHistorySummary;
        changedStatus: boolean;
        summaryChanged: boolean;
      }
    | string {
    const history = this.getRecentHistory(2);

    if (history.length < 2) {
      return "At least two completed audits are required before a comparison is available.";
    }

    const [latest, previous] = history;
    return {
      latest,
      previous,
      changedStatus: latest.status !== previous.status,
      summaryChanged: latest.summary !== previous.summary
    };
  }

  private getLatestAudit(): AuditResult | null {
    const [row] = this.sql<AuditRow>`
      SELECT *
      FROM audit_runs
      ORDER BY completed_at DESC
      LIMIT 1
    `;

    if (!row) {
      return null;
    }

    return {
      runId: row.run_id,
      url: row.url,
      normalizedUrl: row.normalized_url,
      status: row.status,
      summary: row.summary,
      recommendations: JSON.parse(row.recommendations_json),
      findings: JSON.parse(row.findings_json),
      metadata: JSON.parse(row.metadata_json),
      startedAt: row.started_at,
      completedAt: row.completed_at
    };
  }

  private persistAudit(result: AuditResult) {
    this.sql`
      INSERT OR REPLACE INTO audit_runs (
        run_id,
        url,
        normalized_url,
        status,
        summary,
        recommendations_json,
        findings_json,
        metadata_json,
        started_at,
        completed_at
      )
      VALUES (
        ${result.runId},
        ${result.url},
        ${result.normalizedUrl},
        ${result.status},
        ${result.summary},
        ${JSON.stringify(result.recommendations)},
        ${JSON.stringify(result.findings)},
        ${JSON.stringify(result.metadata)},
        ${result.startedAt},
        ${result.completedAt}
      )
    `;
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const mcpTools = this.mcp.getAITools();
    const workersai = createWorkersAI({ binding: this.env.AI });
    const latestAudit = this.getLatestAudit();
    const history = this.getRecentHistory();

    const result = streamText({
      model: workersai(SUMMARY_MODEL, {
        sessionAffinity: this.sessionAffinity
      }),
      system: `You are cf_ai_edge_inspector, a concise website audit agent built on Cloudflare.

Your primary job is to analyze a public URL, trigger a durable website audit workflow, and explain the results.

Rules:
- When the user wants a site checked, audited, analyzed, or inspected, call startWebsiteAudit.
- When the user asks follow-up questions about the most recent audit, call getLatestAudit before answering.
- When the user asks for scan history, call listRecentAudits.
- When the user asks what changed between the latest two runs, call compareRecentAudits.
- Keep answers short, technical, and concrete.
- Do not claim to have checked a URL unless a workflow result exists.

Current agent state:
${JSON.stringify({
  runState: this.state.runState,
  phase: this.state.phase,
  progress: this.state.progress,
  currentUrl: this.state.currentUrl,
  latestSummary: this.state.latestSummary,
  historyCount: history.length
})}`,
      messages: pruneMessages({
        messages: inlineDataUrls(await convertToModelMessages(this.messages)),
        toolCalls: "before-last-2-messages"
      }),
      tools: {
        ...mcpTools,
        startWebsiteAudit: tool({
          description:
            "Start a website audit for a public URL. Use this whenever the user wants a site analyzed.",
          inputSchema: z.object({
            url: z
              .string()
              .min(1)
              .describe("A public URL or bare domain to audit")
          }),
          execute: async ({ url }) => {
            const workflowId = await this.runWorkflow<StartAuditParams>(
              "WEBSITE_AUDIT_WORKFLOW",
              {
                url,
                requestedAt: new Date().toISOString()
              }
            );

            this.setState({
              ...this.state,
              runState: "running",
              phase: "validating",
              progress: 5,
              currentUrl: url,
              activeRunId: workflowId,
              lastError: null
            });

            return {
              workflowId,
              message: `Started a website audit for ${url}.`,
              state: this.state
            };
          }
        }),
        getLatestAudit: tool({
          description:
            "Get the most recent audit result, including findings and recommendations.",
          inputSchema: z.object({}),
          execute: async () => {
            return latestAudit ?? "No website audit has completed yet.";
          }
        }),
        listRecentAudits: tool({
          description: "List recent audit summaries for this chat session.",
          inputSchema: z.object({}),
          execute: async () => {
            return history.length > 0
              ? history
              : "No audit history is available yet.";
          }
        }),
        compareRecentAudits: tool({
          description:
            "Compare the two most recent completed audits and report whether the status or summary changed.",
          inputSchema: z.object({}),
          execute: async () => {
            return this.compareRecentAudits();
          }
        })
      },
      stopWhen: stepCountIs(5),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  async onWorkflowComplete(
    _workflowName: string,
    workflowId: string,
    result?: unknown
  ) {
    if (!result) {
      return;
    }

    const audit = result as AuditResult;
    this.persistAudit(audit);

    this.setState({
      ...this.state,
      runState: "complete",
      phase: "done",
      progress: 100,
      currentUrl: audit.normalizedUrl ?? audit.url,
      activeRunId: null,
      lastCompletedRunId: workflowId,
      lastError: null,
      latestSummary: audit.summary,
      history: this.getRecentHistory()
    });
  }

  async onWorkflowError(
    _workflowName: string,
    _workflowId: string,
    error: string
  ) {
    this.setState({
      ...this.state,
      runState: "error",
      phase: "error",
      activeRunId: null,
      lastError: error
    });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
