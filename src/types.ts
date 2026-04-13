export type ScanStatus =
  | "success"
  | "partial"
  | "blocked"
  | "unreachable"
  | "invalid_url";

export type AuditPhase =
  | "idle"
  | "validating"
  | "fetching"
  | "inspecting"
  | "summarizing"
  | "persisting"
  | "done"
  | "error";

export type AgentRunState = "idle" | "running" | "complete" | "error";

export type FindingSeverity = "high" | "medium" | "low" | "info";

export interface Finding {
  id: string;
  severity: FindingSeverity;
  title: string;
  details: string;
  recommendation: string;
}

export interface AuditMetadata {
  finalUrl: string | null;
  statusCode: number | null;
  contentType: string | null;
  title: string | null;
  metaDescription: string | null;
  redirected: boolean;
  responseTimeMs: number | null;
}

export interface AuditResult {
  runId: string;
  url: string;
  normalizedUrl: string | null;
  status: ScanStatus;
  summary: string;
  recommendations: string[];
  findings: Finding[];
  metadata: AuditMetadata;
  startedAt: string;
  completedAt: string;
}

export interface HistoryEntry {
  runId: string;
  url: string;
  status: ScanStatus;
  summary: string;
  completedAt: string;
}

export interface AgentState {
  runState: AgentRunState;
  phase: AuditPhase;
  progress: number;
  currentUrl: string | null;
  activeRunId: string | null;
  lastCompletedRunId: string | null;
  lastError: string | null;
  latestSummary: string | null;
  history: HistoryEntry[];
}

export interface StartAuditParams {
  url: string;
  requestedAt: string;
}

export interface WorkflowProgress {
  phase: AuditPhase;
  progress: number;
  message: string;
  currentUrl: string | null;
}
