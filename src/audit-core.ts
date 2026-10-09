import { z } from "zod";
import type { AuditResult, Finding, ScanStatus } from "./types";

export const FETCH_TIMEOUT_MS = 8_000;
export const MAX_HTML_BYTES = 1_048_576;
export const MAX_REDIRECTS = 5;
export const AI_TIMEOUT_MS = 20_000;
export const AUDIT_CHECK_COUNTS = {
  responseHeaders: 6,
  htmlMetadata: 2
} as const;

export type NormalizedUrlResult =
  | { ok: true; normalizedUrl: string }
  | { ok: false; reason: string };

export type HeaderSnapshot = {
  hsts: string | null;
  csp: string | null;
  xFrameOptions: string | null;
  xContentTypeOptions: string | null;
  referrerPolicy: string | null;
  cacheControl: string | null;
};

export type FetchSnapshot = {
  statusCode: number | null;
  finalUrl: string | null;
  contentType: string | null;
  responseTimeMs: number | null;
  title: string | null;
  metaDescription: string | null;
  redirected: boolean;
  headers: HeaderSnapshot;
  error: string | null;
  redirectCount: number;
  htmlBytes: number;
  htmlTruncated: boolean;
};

export type AuditDraft = Omit<
  AuditResult,
  "runId" | "summary" | "recommendations" | "completedAt"
> & {
  fallbackSummary: string;
  fallbackRecommendations: string[];
};

export const summarySchema = z.object({
  summary: z.string().trim().min(1).max(320),
  recommendations: z.array(z.string().trim().min(1).max(400)).min(1).max(3)
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

export function buildAuditDraft(
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
  } else if (snapshot.statusCode && snapshot.statusCode >= 300) {
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

  if (!snapshot.error && finalProtocol !== "https:") {
    status = bumpToPartial(status);
    findings.push({
      id: "https-not-enforced",
      severity: "high",
      title: "The final response uses HTTP",
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

  // An error/challenge page cannot establish what the homepage is missing.
  const homepageAvailable =
    !snapshot.error &&
    snapshot.statusCode !== null &&
    snapshot.statusCode >= 200 &&
    snapshot.statusCode < 300;
  for (const rule of homepageAvailable ? MISSING_HEADER_RULES : []) {
    if (snapshot.headers[rule.headerKey]?.trim()) continue;
    if (
      rule.headerKey === "xFrameOptions" &&
      /(?:^|;)\s*frame-ancestors\s+[^;\s]+/i.test(snapshot.headers.csp ?? "")
    )
      continue;
    if (rule.bumpsToPartial) status = bumpToPartial(status);
    findings.push({
      id: rule.id,
      severity: rule.severity,
      title: rule.title,
      details: rule.details,
      recommendation: rule.recommendation
    });
  }

  const metadataAvailable = homepageAvailable && isHtml(snapshot.contentType);
  if (homepageAvailable && !metadataAvailable) {
    status = bumpToPartial(status);
    findings.push({
      id: "non-html-response",
      severity: "info",
      title: "HTML metadata checks were skipped",
      details: `The response Content-Type was ${snapshot.contentType ?? "not provided"}.`,
      recommendation:
        "Audit an HTML page to check its title and meta description."
    });
  }
  if (snapshot.htmlTruncated) {
    status = bumpToPartial(status);
    findings.push({
      id: "html-truncated",
      severity: "info",
      title: "HTML inspection reached the configured size limit",
      details: `Only the first ${snapshot.htmlBytes} bytes were inspected. Missing metadata cannot be established beyond this limit.`,
      recommendation:
        "Keep page metadata near the start of the document and verify oversized pages separately."
    });
  }
  for (const rule of metadataAvailable && !snapshot.htmlTruncated
    ? MISSING_METADATA_RULES
    : []) {
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
      responseTimeMs: snapshot.responseTimeMs,
      redirectCount: snapshot.redirectCount,
      htmlBytes: snapshot.htmlBytes,
      htmlTruncated: snapshot.htmlTruncated
    },
    startedAt,
    fallbackSummary: buildFallbackSummary(status, snapshot, findings).slice(
      0,
      320
    ),
    fallbackRecommendations
  };
}

export function createInvalidUrlResult(
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
      responseTimeMs: null,
      summarySource: "rules",
      summaryFallbackReason: "rules-only"
    },
    startedAt,
    completedAt: new Date().toISOString()
  };
}

function buildFallbackRecommendations(findings: Finding[]): string[] {
  const rank = { high: 0, medium: 1, low: 2, info: 3 };
  const recommendations = Array.from(
    new Set(
      [...findings]
        .sort((a, b) => rank[a.severity] - rank[b.severity])
        .map((finding) => finding.recommendation)
    )
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
      ? "The homepage responded successfully; these limited checks found no high- or medium-risk issues."
      : `The homepage was reachable, but the audit found configuration issues on HTTP ${snapshot.statusCode}.`;

  return topFindings
    ? `${statusLine} Top findings: ${topFindings}.`
    : statusLine;
}

/** URL validation is a literal-host guard, not a DNS rebinding defense. */
export function normalizeUrl(input: string): NormalizedUrlResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: "The URL was empty." };
  if (/\s/.test(trimmed)) {
    return { ok: false, reason: "The URL must not contain whitespace." };
  }
  if (trimmed.includes("\\")) {
    return { ok: false, reason: "Use forward slashes in URLs." };
  }
  // Do not reinterpret ftp:, javascript:, or malformed HTTP URLs as hostnames.
  const explicitScheme = /^[a-z][a-z\d+.-]*:/i.test(trimmed);
  const bareHostWithPort = /^[^/:]+:\d+(?:[/?#]|$)/.test(trimmed);
  if (explicitScheme && !bareHostWithPort && !/^https?:\/\//i.test(trimmed)) {
    return { ok: false, reason: "Only http and https URLs are supported." };
  }
  try {
    const parsed = new URL(
      /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    );
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { ok: false, reason: "Only http and https URLs are supported." };
    }
    if (parsed.username || parsed.password) {
      return {
        ok: false,
        reason: "URLs containing credentials are not supported."
      };
    }
    if (!isPublicHostname(parsed.hostname)) {
      return {
        ok: false,
        reason: "Use a public hostname or public IP address."
      };
    }
    parsed.hash = ""; // Fragments are browser-only and never sent to the origin.
    return { ok: true, normalizedUrl: parsed.toString() };
  } catch {
    return { ok: false, reason: "The URL could not be parsed." };
  }
}

function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[")) {
    // Restrict IPv6 literals to global unicast 2000::/3. Domain names still work
    // normally on IPv6. This also excludes IPv4-mapped loopback addresses.
    return /^\[[23][0-9a-f]{0,3}:/.test(host);
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  return (
    host.includes(".") &&
    !/(^|\.)(localhost|local|internal|test|invalid)$/.test(host) &&
    host
      .split(".")
      .every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label))
  );
}

function emptyHeaders(): HeaderSnapshot {
  return {
    hsts: null,
    csp: null,
    xFrameOptions: null,
    xContentTypeOptions: null,
    referrerPolicy: null,
    cacheControl: null
  };
}

function isHtml(contentType: string | null): boolean {
  return /^text\/html(?:\s*;|$)/i.test(contentType?.trim() ?? "");
}

export interface FetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxHtmlBytes?: number;
  now?: () => number;
}

/** Measures fetching + redirects + bounded HTML reading, not browser page load. */
export async function fetchHomepageSnapshot(
  url: string,
  options: FetchOptions = {}
): Promise<FetchSnapshot> {
  const {
    fetchImpl = fetch,
    timeoutMs = FETCH_TIMEOUT_MS,
    maxHtmlBytes = MAX_HTML_BYTES,
    now = Date.now
  } = options;
  const controller = new AbortController();
  const startedAt = now();
  let timedOut = false;
  let redirectCount = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      const error = new Error(
        `The request timed out after ${timeoutMs / 1000} seconds.`
      );
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      deadline,
      (async () => {
        let current = url;
        for (;;) {
          const normalized = normalizeUrl(current);
          if (!normalized.ok) throw new Error(normalized.reason);
          current = normalized.normalizedUrl;
          const response = await fetchImpl(current, {
            redirect: "manual",
            signal: controller.signal,
            headers: { "user-agent": "cf_ai_edge_inspector/0.1" }
          });
          const location = response.headers.get("location");
          if ([301, 302, 303, 307, 308].includes(response.status) && location) {
            await response.body?.cancel();
            if (redirectCount >= MAX_REDIRECTS) {
              throw new Error(
                `The request exceeded ${MAX_REDIRECTS} redirects.`
              );
            }
            current = new URL(location, current).toString();
            redirectCount += 1;
            continue; // Validate each redirect before making the next request.
          }
          const contentType = response.headers.get("content-type");
          const body = isHtml(contentType)
            ? await readBoundedHtml(response, maxHtmlBytes)
            : { html: "", bytes: 0, truncated: false };
          if (!isHtml(contentType)) await response.body?.cancel();
          return {
            statusCode: response.status,
            finalUrl: current,
            contentType,
            responseTimeMs: now() - startedAt,
            title: extractTitle(body.html),
            metaDescription: extractMetaDescription(body.html),
            redirected: redirectCount > 0,
            redirectCount,
            htmlBytes: body.bytes,
            htmlTruncated: body.truncated,
            headers: {
              hsts: response.headers.get("strict-transport-security"),
              csp: response.headers.get("content-security-policy"),
              xFrameOptions: response.headers.get("x-frame-options"),
              xContentTypeOptions: response.headers.get(
                "x-content-type-options"
              ),
              referrerPolicy: response.headers.get("referrer-policy"),
              cacheControl: response.headers.get("cache-control")
            },
            error: null
          };
        }
      })()
    ]);
  } catch (error) {
    return {
      statusCode: null,
      finalUrl: null,
      contentType: null,
      responseTimeMs: now() - startedAt,
      title: null,
      metaDescription: null,
      redirected: redirectCount > 0,
      redirectCount,
      htmlBytes: 0,
      htmlTruncated: false,
      headers: emptyHeaders(),
      error: timedOut
        ? `The request timed out after ${timeoutMs / 1000} seconds.`
        : error instanceof Error
          ? error.message
          : "Unknown fetch error"
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedHtml(response: Response, maxBytes: number) {
  if (!response.body) return { html: "", bytes: 0, truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let html = "";
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - bytes;
      const chunk = value.subarray(0, remaining);
      html += decoder.decode(chunk, { stream: true });
      bytes += chunk.byteLength;
      if (value.byteLength > remaining || bytes === maxBytes) {
        // Conservatively mark a response that reaches the cap as incomplete.
        truncated = true;
        await reader.cancel();
        break;
      }
    }
    html += decoder.decode();
    return { html, bytes, truncated };
  } finally {
    reader.releaseLock();
  }
}

function metadataHtml(html: string): string {
  // This is static HTML extraction, not DOM rendering or JavaScript execution.
  // Skip whichever block begins first. Separate passes would misinterpret a
  // comment marker inside a script, or a script marker inside a comment.
  const blockPattern = /<!--|<(script|style)(?=[\s/>])[^<>]*>/gi;
  const pieces: string[] = [];
  let cursor = 0;
  let block: RegExpExecArray | null;
  while ((block = blockPattern.exec(html))) {
    pieces.push(html.slice(cursor, block.index));
    let end = -1;
    if (block[0] === "<!--") {
      const closing = html.indexOf("-->", blockPattern.lastIndex);
      if (closing >= 0) end = closing + 3;
    } else {
      const closingPattern = new RegExp(`</${block[1]}\\s*>`, "gi");
      closingPattern.lastIndex = blockPattern.lastIndex;
      const closing = closingPattern.exec(html);
      if (closing) end = closingPattern.lastIndex;
    }
    if (end < 0) return pieces.join("");
    cursor = end;
    blockPattern.lastIndex = end;
  }
  pieces.push(html.slice(cursor));
  return pieces.join("");
}

function decodeHtml(value: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " "
  };
  return value
    .replace(
      /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
      (match, name: string) => {
        if (!name.startsWith("#")) return entities[name.toLowerCase()] ?? match;
        const codePoint = name.toLowerCase().startsWith("#x")
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10);
        return codePoint > 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : "\ufffd";
      }
    )
    .replace(/\s+/g, " ")
    .trim();
}

export function extractTitle(html: string): string | null {
  const source = metadataHtml(html);
  const opening = /<title(?=[\s>])[^<>]*>/i.exec(source);
  if (!opening) return null;
  const start = opening.index + opening[0].length;
  const closingPattern = /<\/title\s*>/gi;
  closingPattern.lastIndex = start;
  const closing = closingPattern.exec(source);
  return closing
    ? decodeHtml(source.slice(start, closing.index)) || null
    : null;
}

export function extractMetaDescription(html: string): string | null {
  const source = metadataHtml(html);
  const openingPattern = /<meta(?=[\s/>])/gi;
  // Consume each candidate once. A whole-tag regex can repeatedly scan the
  // remaining document when malicious HTML contains many unfinished tags.
  while (openingPattern.exec(source)) {
    const start = openingPattern.lastIndex;
    let cursor = start;
    let quote: string | null = null;
    for (; cursor < source.length; cursor += 1) {
      const char = source[cursor];
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === ">" || char === "<") break;
    }
    openingPattern.lastIndex = cursor + (source[cursor] === ">" ? 1 : 0);
    if (cursor === source.length) return null;
    if (source[cursor] !== ">") continue;
    const attrs = readAttributes(source.slice(start, cursor));
    if (attrs.name?.toLowerCase() === "description" && attrs.content) {
      return decodeHtml(attrs.content) || null;
    }
  }
  return null;
}

function readAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = Object.create(null);
  let cursor = 0;
  while (cursor < source.length) {
    while (cursor < source.length && /[\s/]/.test(source[cursor])) cursor += 1;
    const start = cursor;
    while (cursor < source.length && !/[\s=/]/.test(source[cursor]))
      cursor += 1;
    const name = source.slice(start, cursor).toLowerCase();
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
    if (source[cursor] !== "=") continue;
    cursor += 1;
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
    const quote =
      source[cursor] === '"' || source[cursor] === "'"
        ? source[cursor++]
        : null;
    const valueStart = cursor;
    if (quote) {
      while (cursor < source.length && source[cursor] !== quote) cursor += 1;
    } else {
      while (cursor < source.length && !/\s/.test(source[cursor])) cursor += 1;
    }
    if (name && !(name in attrs))
      attrs[name] = source.slice(valueStart, cursor);
    if (quote) cursor += 1;
  }
  return attrs;
}

export type AuditSummary = {
  summary: string;
  recommendations: string[];
  source: "ai" | "rules";
  fallbackReason:
    | "rules-only"
    | "ai-error"
    | "invalid-ai-output"
    | "ai-timeout"
    | null;
};

/** AI can rewrite the explanation; it cannot change deterministic findings. */
export async function summarizeWithFallback(
  draft: AuditDraft,
  generate?: (signal: AbortSignal) => Promise<unknown>,
  options: { timeoutMs?: number } = {}
): Promise<AuditSummary> {
  const fallback = (reason: AuditSummary["fallbackReason"]): AuditSummary => ({
    summary: draft.fallbackSummary,
    recommendations: draft.fallbackRecommendations,
    source: "rules",
    fallbackReason: reason
  });
  if (!generate) return fallback("rules-only");
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const object = await Promise.race([
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          const error = new Error("AI summary deadline exceeded");
          controller.abort(error);
          reject(error);
        }, options.timeoutMs ?? AI_TIMEOUT_MS);
      }),
      generate(controller.signal)
    ]);
    const parsed = summarySchema.safeParse(object);
    return parsed.success
      ? { ...parsed.data, source: "ai", fallbackReason: null }
      : fallback("invalid-ai-output");
  } catch {
    return fallback(timedOut ? "ai-timeout" : "ai-error");
  } finally {
    clearTimeout(timeout);
  }
}
