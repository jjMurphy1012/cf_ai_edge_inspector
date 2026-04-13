import { generateObject } from "ai";
import { AgentWorkflow, type AgentWorkflowStep } from "agents/workflows";
import { type WorkflowEvent } from "cloudflare:workers";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import type { AuditAgent } from "./server";
import type {
  AuditResult,
  Finding,
  ScanStatus,
  StartAuditParams,
  WorkflowProgress
} from "./types";

type NormalizedUrlResult =
  | { ok: true; normalizedUrl: string }
  | { ok: false; reason: string };

type HeaderSnapshot = {
  hsts: string | null;
  csp: string | null;
  xFrameOptions: string | null;
  xContentTypeOptions: string | null;
  referrerPolicy: string | null;
  cacheControl: string | null;
};

type FetchSnapshot = {
  statusCode: number | null;
  finalUrl: string | null;
  contentType: string | null;
  responseTimeMs: number | null;
  title: string | null;
  metaDescription: string | null;
  redirected: boolean;
  headers: HeaderSnapshot;
  error: string | null;
};

type AuditDraft = Omit<
  AuditResult,
  "runId" | "summary" | "recommendations" | "completedAt"
> & {
  fallbackSummary: string;
  fallbackRecommendations: string[];
};

const SUMMARY_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const summarySchema = z.object({
  summary: z.string().min(1).max(320),
  recommendations: z.array(z.string().min(1)).min(1).max(3)
});

type MissingHeaderRule = {
  headerKey: keyof HeaderSnapshot;
  id: string;
  severity: Finding["severity"];
  title: string;
  details: string;
  recommendation: string;
  bumpsToPartial: boolean;
};

const MISSING_HEADER_RULES: readonly MissingHeaderRule[] = [
  {
    headerKey: "hsts",
    id: "missing-hsts",
    severity: "medium",
    title: "Missing Strict-Transport-Security header",
    details:
      "Without HSTS, browsers may continue to use insecure transport for future visits.",
    recommendation:
      "Add a Strict-Transport-Security header after validating that HTTPS is correctly enforced.",
    bumpsToPartial: true
  },
  {
    headerKey: "csp",
    id: "missing-csp",
    severity: "medium",
    title: "Missing Content-Security-Policy header",
    details:
      "A missing CSP reduces protection against script injection and unsafe third-party content.",
    recommendation:
      "Define a baseline Content-Security-Policy that limits script, frame, and object sources.",
    bumpsToPartial: true
  },
  {
    headerKey: "xFrameOptions",
    id: "missing-x-frame-options",
    severity: "low",
    title: "Missing X-Frame-Options header",
    details:
      "This makes it easier for other sites to embed the page in an iframe.",
    recommendation:
      "Add X-Frame-Options or an equivalent frame-ancestors CSP directive.",
    bumpsToPartial: false
  },
  {
    headerKey: "xContentTypeOptions",
    id: "missing-x-content-type-options",
    severity: "low",
    title: "Missing X-Content-Type-Options header",
    details:
      "Browsers may try to MIME-sniff content when this header is absent.",
    recommendation:
      "Return X-Content-Type-Options: nosniff for public responses.",
    bumpsToPartial: false
  },
  {
    headerKey: "referrerPolicy",
    id: "missing-referrer-policy",
    severity: "low",
    title: "Missing Referrer-Policy header",
    details:
      "The browser may leak more referrer information than intended on cross-site navigation.",
    recommendation:
      "Set a Referrer-Policy such as strict-origin-when-cross-origin.",
    bumpsToPartial: false
  },
  {
    headerKey: "cacheControl",
    id: "missing-cache-control",
    severity: "medium",
    title: "Missing Cache-Control header",
    details: "No cache directive was detected on the homepage response.",
    recommendation:
      "Add explicit Cache-Control directives so browsers and edge caches know how to treat the response.",
    bumpsToPartial: true
  }
];

type MissingMetadataRule = {
  snapshotKey: "title" | "metaDescription";
  id: string;
  severity: Finding["severity"];
  title: string;
  details: string;
  recommendation: string;
};

const MISSING_METADATA_RULES: readonly MissingMetadataRule[] = [
  {
    snapshotKey: "title",
    id: "missing-title",
    severity: "low",
    title: "Missing HTML title",
    details:
      "The page did not expose a title element in the fetched homepage HTML.",
    recommendation:
      "Add a descriptive title tag so the page is identifiable in browsers and search results."
  },
  {
    snapshotKey: "metaDescription",
    id: "missing-meta-description",
    severity: "info",
    title: "Missing meta description",
    details: "No meta description was found in the fetched homepage HTML.",
    recommendation:
      "Add a concise meta description to improve how the page is summarized externally."
  }
];

export class WebsiteAuditWorkflow extends AgentWorkflow<
  AuditAgent,
  StartAuditParams,
  WorkflowProgress,
  Env
> {
  async run(
    event: WorkflowEvent<StartAuditParams>,
    step: AgentWorkflowStep
  ): Promise<AuditResult> {
    const requestedUrl = event.payload.url;
    const startedAt = event.payload.requestedAt;

    await step.mergeAgentState({
      runState: "running",
      phase: "validating",
      progress: 5,
      currentUrl: requestedUrl,
      activeRunId: this.workflowId,
      lastError: null,
      latestSummary: null
    });

    const normalized = await step.do("normalize-url", async () =>
      normalizeUrl(requestedUrl)
    );

    if (!normalized.ok) {
      const invalidResult = createInvalidUrlResult(
        requestedUrl,
        normalized.reason,
        startedAt,
        this.workflowId
      );
      await step.mergeAgentState({
        phase: "done",
        progress: 100,
        latestSummary: invalidResult.summary
      });
      await step.reportComplete(invalidResult);
      return invalidResult;
    }

    await step.mergeAgentState({
      phase: "fetching",
      progress: 25,
      currentUrl: normalized.normalizedUrl
    });

    const snapshot = await step.do("fetch-homepage", async () =>
      fetchHomepageSnapshot(normalized.normalizedUrl)
    );

    await step.mergeAgentState({
      phase: "inspecting",
      progress: 55,
      currentUrl: normalized.normalizedUrl
    });

    const draft = await step.do("build-audit-draft", async () =>
      buildAuditDraft(
        requestedUrl,
        normalized.normalizedUrl,
        startedAt,
        snapshot
      )
    );

    await step.mergeAgentState({
      phase: "summarizing",
      progress: 80,
      currentUrl: normalized.normalizedUrl
    });

    const aiSummary = await step.do("generate-ai-summary", async () =>
      generateAuditSummary(this.env, draft)
    );

    const result = await step.do("finalize-result", async () => ({
      runId: this.workflowId,
      url: draft.url,
      normalizedUrl: draft.normalizedUrl,
      status: draft.status,
      summary: aiSummary.summary,
      recommendations: aiSummary.recommendations,
      findings: draft.findings,
      metadata: draft.metadata,
      startedAt: draft.startedAt,
      completedAt: new Date().toISOString()
    }));

    await step.mergeAgentState({
      phase: "persisting",
      progress: 95,
      latestSummary: result.summary
    });
    await step.reportComplete(result);

    return result;
  }
}

function normalizeUrl(input: string): NormalizedUrlResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, reason: "The URL was empty." };
  }

  const candidate = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { ok: false, reason: "Only http and https URLs are supported." };
    }

    return { ok: true, normalizedUrl: parsed.toString() };
  } catch {
    return { ok: false, reason: "The URL could not be parsed." };
  }
}

async function fetchHomepageSnapshot(url: string): Promise<FetchSnapshot> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), 8000);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "cf_ai_edge_inspector/0.1"
      }
    });

    const contentType = response.headers.get("content-type");
    const html =
      contentType && contentType.includes("text/html")
        ? await response.text()
        : "";

    return {
      statusCode: response.status,
      finalUrl: response.url || url,
      contentType,
      responseTimeMs: Date.now() - startedAt,
      title: extractTitle(html),
      metaDescription: extractMetaDescription(html),
      redirected: response.url !== url,
      headers: {
        hsts: response.headers.get("strict-transport-security"),
        csp: response.headers.get("content-security-policy"),
        xFrameOptions: response.headers.get("x-frame-options"),
        xContentTypeOptions: response.headers.get("x-content-type-options"),
        referrerPolicy: response.headers.get("referrer-policy"),
        cacheControl: response.headers.get("cache-control")
      },
      error: null
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown fetch error";
    return {
      statusCode: null,
      finalUrl: null,
      contentType: null,
      responseTimeMs: null,
      title: null,
      metaDescription: null,
      redirected: false,
      headers: {
        hsts: null,
        csp: null,
        xFrameOptions: null,
        xContentTypeOptions: null,
        referrerPolicy: null,
        cacheControl: null
      },
      error:
        message === "timeout"
          ? "The request timed out after 8 seconds."
          : message
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildAuditDraft(
  originalUrl: string,
  normalizedUrl: string,
  startedAt: string,
  snapshot: FetchSnapshot
): AuditDraft {
  const findings: Finding[] = [];
  let status: ScanStatus = "success";

  if (snapshot.error) {
    status = "unreachable";
    findings.push({
      id: "site-unreachable",
      severity: "high",
      title: "The site could not be reached from the Worker runtime",
      details: snapshot.error,
      recommendation:
        "Confirm the hostname is reachable and that the origin allows requests from Cloudflare egress."
    });
  } else if (snapshot.statusCode === 403 || snapshot.statusCode === 429) {
    status = "blocked";
    findings.push({
      id: "site-blocked",
      severity: "high",
      title: "The target site blocked or rate-limited the request",
      details: `Received HTTP ${snapshot.statusCode}.`,
      recommendation:
        "Treat this as a valid outcome, then verify whether the origin intentionally blocks Cloudflare traffic."
    });
  } else if (snapshot.statusCode && snapshot.statusCode >= 400) {
    status = "partial";
    findings.push({
      id: "non-success-status",
      severity: "high",
      title: "The homepage did not return a successful status",
      details: `Received HTTP ${snapshot.statusCode}.`,
      recommendation:
        "Investigate why the public homepage is returning an error before tuning caching or headers."
    });
  }

  const finalProtocol = snapshot.finalUrl
    ? new URL(snapshot.finalUrl).protocol
    : new URL(normalizedUrl).protocol;

  const bumpToPartial = (s: ScanStatus): ScanStatus =>
    s === "success" ? "partial" : s;

  if (finalProtocol !== "https:") {
    status = bumpToPartial(status);
    findings.push({
      id: "https-not-enforced",
      severity: "high",
      title: "HTTPS is not enforced",
      details:
        "The final URL did not resolve to an HTTPS page, which weakens transport security.",
      recommendation:
        "Redirect all public traffic to HTTPS and enable HSTS once the HTTPS path is stable."
    });
  }

  if (snapshot.redirected && snapshot.finalUrl) {
    findings.push({
      id: "redirect-detected",
      severity: "info",
      title: "The request followed a redirect",
      details: `Final destination: ${snapshot.finalUrl}`,
      recommendation:
        "Keep redirect chains short and direct users to the canonical destination in a single hop."
    });
  }

  for (const rule of MISSING_HEADER_RULES) {
    if (snapshot.headers[rule.headerKey]) continue;
    if (rule.bumpsToPartial) status = bumpToPartial(status);
    findings.push({
      id: rule.id,
      severity: rule.severity,
      title: rule.title,
      details: rule.details,
      recommendation: rule.recommendation
    });
  }

  for (const rule of MISSING_METADATA_RULES) {
    if (snapshot[rule.snapshotKey]) continue;
    findings.push({
      id: rule.id,
      severity: rule.severity,
      title: rule.title,
      details: rule.details,
      recommendation: rule.recommendation
    });
  }

  const fallbackRecommendations = buildFallbackRecommendations(findings);

  return {
    url: originalUrl,
    normalizedUrl,
    status,
    findings,
    metadata: {
      finalUrl: snapshot.finalUrl,
      statusCode: snapshot.statusCode,
      contentType: snapshot.contentType,
      title: snapshot.title,
      metaDescription: snapshot.metaDescription,
      redirected: snapshot.redirected,
      responseTimeMs: snapshot.responseTimeMs
    },
    startedAt,
    fallbackSummary: buildFallbackSummary(status, snapshot, findings),
    fallbackRecommendations
  };
}

async function generateAuditSummary(
  env: Env,
  draft: AuditDraft
): Promise<{ summary: string; recommendations: string[] }> {
  const workersai = createWorkersAI({ binding: env.AI });

  try {
    const { object } = await generateObject({
      model: workersai(SUMMARY_MODEL),
      schema: summarySchema,
      system:
        "You summarize website audit results for engineers. Be concise, concrete, and avoid hype.",
      prompt: JSON.stringify({
        url: draft.url,
        status: draft.status,
        metadata: draft.metadata,
        findings: draft.findings
      })
    });

    return object;
  } catch {
    return {
      summary: draft.fallbackSummary,
      recommendations: draft.fallbackRecommendations
    };
  }
}

function createInvalidUrlResult(
  originalUrl: string,
  reason: string,
  startedAt: string,
  runId: string
): AuditResult {
  return {
    runId,
    url: originalUrl,
    normalizedUrl: null,
    status: "invalid_url",
    summary: "The submitted URL could not be audited because it was invalid.",
    recommendations: [
      "Submit a full public URL or bare domain that resolves over HTTP or HTTPS."
    ],
    findings: [
      {
        id: "invalid-url",
        severity: "high",
        title: "Invalid URL input",
        details: reason,
        recommendation:
          "Use a public http or https URL. If the user pasted a bare hostname, try the https version first."
      }
    ],
    metadata: {
      finalUrl: null,
      statusCode: null,
      contentType: null,
      title: null,
      metaDescription: null,
      redirected: false,
      responseTimeMs: null
    },
    startedAt,
    completedAt: new Date().toISOString()
  };
}

function buildFallbackRecommendations(findings: Finding[]): string[] {
  const recommendations = Array.from(
    new Set(findings.map((finding) => finding.recommendation))
  ).filter(Boolean);

  if (recommendations.length > 0) {
    return recommendations.slice(0, 3);
  }

  return [
    "Re-run the audit after configuration changes to confirm the public response looks healthy."
  ];
}

function buildFallbackSummary(
  status: ScanStatus,
  snapshot: FetchSnapshot,
  findings: Finding[]
): string {
  if (status === "invalid_url") {
    return "The submitted URL could not be parsed into a public HTTP(S) address.";
  }

  if (status === "unreachable") {
    return "The Worker runtime could not reach the target URL, so the audit stopped before header and metadata checks could complete.";
  }

  if (status === "blocked") {
    return "The target origin responded, but it blocked or rate-limited the audit request.";
  }

  const topFindings = findings
    .slice(0, 3)
    .map((finding) => finding.title)
    .join("; ");

  const statusLine =
    status === "success"
      ? "The homepage responded successfully and only low-risk issues were detected."
      : `The homepage was reachable, but the audit found configuration issues on HTTP ${snapshot.statusCode}.`;

  return topFindings
    ? `${statusLine} Top findings: ${topFindings}.`
    : statusLine;
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1]?.trim() || null;
}

function extractMetaDescription(html: string): string | null {
  const quoted =
    html.match(
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["'][^>]*>/i
    ) ||
    html.match(
      /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["'][^>]*>/i
    );

  return quoted?.[1]?.trim() || null;
}
