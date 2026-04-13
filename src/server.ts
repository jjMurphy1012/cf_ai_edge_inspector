import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { streamText } from "ai";
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

type AuditIntent =
  | { kind: "start_audit"; url: string }
  | { kind: "compare" }
  | { kind: "history" }
  | { kind: "latest" }
  | { kind: "follow_up" }
  | { kind: "empty" };

function extractTextFromParts(
  parts: Array<{ type: string; text?: string }> | undefined
) {
  if (!parts) {
    return "";
  }

  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function getLatestUserText(
  messages: Array<{
    role: string;
    parts?: Array<{ type: string; text?: string }>;
  }>
) {
  const latestUser = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  return latestUser ? extractTextFromParts(latestUser.parts) : "";
}

function extractAuditCandidate(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const explicitUrl = trimmed.match(/https?:\/\/[^\s)]+/i);
  if (explicitUrl) {
    return explicitUrl[0];
  }

  const domainLike = trimmed.match(
    /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s)]*)?\b/i
  );
  return domainLike?.[0] ?? null;
}

function classifyIntent(text: string): AuditIntent {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return { kind: "empty" };
  }

  const candidateUrl = extractAuditCandidate(text);
  if (candidateUrl) {
    return { kind: "start_audit", url: candidateUrl };
  }

  if (
    /(compare|what changed|changed|difference|previous scan|last scan)/i.test(
      text
    )
  ) {
    return { kind: "compare" };
  }

  if (
    /(history|recent audits|recent scans|past audits|past scans|list audits)/i.test(
      text
    )
  ) {
    return { kind: "history" };
  }

  if (
    /(latest audit|last audit|latest result|last result|show latest|show last|summary)/i.test(
      text
    )
  ) {
    return { kind: "latest" };
  }

  return { kind: "follow_up" };
}

function compactAuditResult(audit: AuditResult | null) {
  if (!audit) {
    return null;
  }

  return {
    runId: audit.runId,
    url: audit.url,
    normalizedUrl: audit.normalizedUrl,
    status: audit.status,
    summary: audit.summary,
    recommendations: audit.recommendations,
    findings: audit.findings.map((finding) => ({
      severity: finding.severity,
      title: finding.title,
      details: finding.details,
      recommendation: finding.recommendation
    })),
    metadata: audit.metadata,
    completedAt: audit.completedAt
  };
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

  private streamReply(prompt: string, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    return streamText({
      model: workersai(SUMMARY_MODEL, {
        sessionAffinity: this.sessionAffinity
      }),
      system: `You are cf_ai_edge_inspector, a concise website audit agent built on Cloudflare.

Answer with short, technical, direct prose.
- Use only the context provided in the prompt.
- Do not invent scan results.
- If no result exists yet, say so plainly.
- Prefer 2-4 sentences.`,
      prompt,
      abortSignal: options?.abortSignal
    }).toUIMessageStreamResponse();
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const latestAudit = this.getLatestAudit();
    const history = this.getRecentHistory();
    const latestUserText = getLatestUserText(this.messages);
    const intent = classifyIntent(latestUserText);

    if (intent.kind === "empty") {
      return this.streamReply(
        "The user sent an empty message. Ask them to submit a public URL like https://example.com.",
        options
      );
    }

    if (intent.kind === "start_audit") {
      if (this.state.runState === "running" && this.state.currentUrl) {
        return this.streamReply(
          `An audit is already running for ${this.state.currentUrl}. Tell the user to wait for completion before starting another one.`,
          options
        );
      }

      const workflowId = await this.runWorkflow<StartAuditParams>(
        "WEBSITE_AUDIT_WORKFLOW",
        {
          url: intent.url,
          requestedAt: new Date().toISOString()
        }
      );

      this.setState({
        ...this.state,
        runState: "running",
        phase: "validating",
        progress: 5,
        currentUrl: intent.url,
        activeRunId: workflowId,
        lastError: null
      });

      return this.streamReply(
        `A website audit has started for ${intent.url}. Tell the user the progress panel will update live and that they can ask follow-up questions after the run completes.`,
        options
      );
    }

    if (!latestAudit) {
      if (this.state.runState === "running" && this.state.currentUrl) {
        return this.streamReply(
          `An audit is currently running for ${this.state.currentUrl}, but no completed result exists yet. Tell the user to wait for the summary and progress updates.`,
          options
        );
      }

      return this.streamReply(
        "No completed audit exists for this chat yet. Ask the user to submit a public website URL to inspect.",
        options
      );
    }

    if (intent.kind === "compare") {
      return this.streamReply(
        `Explain this comparison between the latest two completed audits.

Comparison data:
${JSON.stringify(this.compareRecentAudits(), null, 2)}`,
        options
      );
    }

    if (intent.kind === "history") {
      return this.streamReply(
        `Summarize the recent audit history for the user in a compact bullet-free format.

History:
${JSON.stringify(history, null, 2)}`,
        options
      );
    }

    if (intent.kind === "latest") {
      return this.streamReply(
        `Summarize the most recent completed audit for the user.

Latest audit:
${JSON.stringify(compactAuditResult(latestAudit), null, 2)}`,
        options
      );
    }

    return this.streamReply(
      `Answer the user's follow-up question using only the latest completed audit and recent history.

User question:
${latestUserText}

Latest audit:
${JSON.stringify(compactAuditResult(latestAudit), null, 2)}

Recent history:
${JSON.stringify(history, null, 2)}`,
      options
    );
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
