# PROMPTS.md

AI-assisted development prompts for `cf_ai_edge_inspector`.

## How two models were used

Two development-time models were used in deliberately separated roles, so that every major decision was produced by one model and reviewed by the other. This pairing — implementation on one side, adversarial review on the other — was used to reduce single-model bias, catch hallucinated APIs, and surface Cloudflare-specific risks that a single model would have glossed over.

- **GPT-5.4 (Codex)** — project scaffolding and implementation: repo setup, `cloudflare/agents-starter` conversion into the audit-agent skeleton, `wrangler.jsonc` binding wiring, `AuditAgent` + `WebsiteAuditWorkflow` implementation, Wrangler auth, deployment, and post-deploy verification.
- **Claude Opus 4.6 (Claude Code)** — staged review and refinement: feasibility review of every plan before it was executed, cross-model audit of GPT-5.4's output, code-level evaluation and architectural tightening (Agent-thin / Workflow-thick boundary, step idempotency, isolated AI step, frontend state subscription), documentation polish, and end-to-end integration checks.

Runtime LLM (Workers AI / Llama 3.3) is documented in `README.md` and is intentionally kept separate from the development-time models listed below.

Each entry records two things:

- **Model** — the AI tool used at that stage
- **Prompt** — the engineering request sent to that model

## Entries

### Stage 1 — Planning

#### 2026-04-13 — Assignment scoping, project selection, and architecture mapping

**Model**  
GPT-5.4 Codex, Claude Opus 4.6

**Prompt**  
Summarize the hard requirements of Cloudflare's AI app assignment, separate them from recommended choices, and list the final deliverables required for submission. Propose several Cloudflare-native project ideas, rank them by platform fit and implementation risk, and recommend one. Map the assignment's four required components — LLM, workflow/coordination, chat input, and memory/state — onto the smallest viable Cloudflare-native stack.

#### 2026-04-13 — Feasibility review of the initial implementation plan

**Model**  
Claude Opus 4.6 (Claude Code)

**Prompt**  
Review the proposed implementation plan and 20-step todo list for `cf_ai_edge_inspector`. Assess feasibility, identify weak points, and flag Cloudflare-specific risks the plan may underestimate, including Workers subrequest limits, Durable Object migration format, the Workflows versus Durable Objects trade-off, model latency on Workers AI, and Pages versus Workers + static assets deployment.

#### 2026-04-13 — Cross-model validation of the review

**Model**  
GPT-5.4

**Prompt**  
Evaluate each suggestion from the previous review against current Cloudflare documentation. For every point, decide whether to adopt, adjust, or reject, and cite the relevant Cloudflare docs. Produce concrete adjustments covering the scan result status taxonomy, model selection strategy, Durable Object SQLite migration, and final deployment choice.

#### 2026-04-13 — Final consolidated plan

**Model**  
Claude Opus 4.6 (Claude Code)

**Prompt**  
Treat the cross-model critique of the earlier recommendations as input that is not necessarily correct, in order to counter sycophantic agreement and reduce hallucinated justification. Produce the final architectural recommendation and a single consolidated todo list. Resolve contradictions between the two prior rounds and add any constraints both drafts missed, in particular Workflow step idempotency, isolating the Workers AI call in its own Workflow step for independent retry and graceful degradation, and subscribing the frontend to Agent state instead of polling for progress.

### Stage 2 — Scaffolding and repository setup

#### 2026-04-13 — Project initialization from the final plan

**Model**  
GPT-5.4 Codex

**Prompt**  
Initialize the project from the final consolidated plan: TypeScript only; Workers + Agents SDK + Durable Objects (SQLite) + Workflows + Workers AI; Agent-thin and Workflow-thick; frontend subscribes to Agent state. Set up the `cloudflare/agents-starter` scaffold at the repository root and prepare the project for dependency installation and Cloudflare binding configuration.

#### 2026-04-13 — Repository consolidation and remote setup

**Model**  
Claude Opus 4.6 (Claude Code)

**Prompt**  
Consolidate the project at the repository root, remove duplicate scaffold directories, and ensure `node_modules`, `.wrangler`, `.dev.vars`, and local IDE configuration are excluded from version control. Create the initial commit, bind the GitHub remote, and publish the `main` branch.

### Stage 3 — Implementation

#### 2026-04-13 — Starter conversion into the project-specific skeleton

**Model**  
GPT-5.4 Codex

**Prompt**  
Convert the generic Cloudflare starter into the project-specific skeleton according to the final plan. Keep the implementation aligned with the locked-in architectural constraints.

#### 2026-04-13 — Staged review of implementation progress

**Model**  
Claude Opus 4.6 (Claude Code)

**Prompt**  
Review the current staged deliverables against the locked-in plan, identify drift, gaps, and risks, and produce a refined todo list for the next execution pass. Proceed to execute the refined list autonomously, then run the `/simplify` skill on the resulting changes for code reuse, quality, and efficiency cleanup.

### Stage 4 — Validation and deployment

#### 2026-04-13 — Local validation and blocker diagnosis

**Model**  
GPT-5.4 Codex

**Prompt**  
Install root dependencies, regenerate `env.d.ts`, run lint and TypeScript checks, and verify whether local dev starts successfully. If local dev is blocked, identify the exact prerequisite and update the docs so the repository reflects the current state truthfully.

#### 2026-04-13 — Cloudflare authentication, deployment, and live verification

**Model**  
GPT-5.4 Codex

**Prompt**  
Continue executing the remaining todo list. Authenticate Wrangler with Cloudflare, start local dev, identify any binding-related blockers, deploy the current Worker, verify the live `workers.dev` URL, and update README/PROMPTS so the deployed state is accurately documented.

#### 2026-04-13 — Post-deployment assessment and submission readiness

**Model**  
Claude Opus 4.6 (Claude Code)

**Prompt**  
Inspect the current git state, local implementation, and the live deployment. Evaluate whether the project is in a submittable state, identify the highest-impact remaining gaps — including uncommitted implementation work, end-to-end browser verification of the audit flow, real-URL coverage for status taxonomy, and README polish — and produce a prioritized next-step plan.

### Stage 5 — Hardening and cleanup

#### 2026-04-13 — Parallel code review and targeted cleanup

**Model**  
Claude Opus 4.6 (Claude Code)

**Prompt**  
Review the recently changed implementation files along three dimensions in parallel: reuse of existing utilities and SDK helpers, code quality (redundant state, copy-paste, leaky abstractions, stringly-typed code, narrating comments), and efficiency (hot-path bloat, missed concurrency, no-op state broadcasts, listener leaks). Aggregate findings, fix only the high-impact low-risk items, and defer broader refactors that are not safe to land pre-submission. Preserve architectural boundaries and keep the deployed behavior intact.

#### 2026-04-13 — Audit routing stabilization and live validation

**Model**  
GPT-5.4 Codex

**Prompt**  
Stabilize the audit entry path so a user message like `Analyze <url>` deterministically starts the workflow without depending on model tool calling. Move intent recognition and URL extraction into the Agent, ensure the workflow explicitly reports completion so results reach SQLite, and extend the live validation script to cover success, redirect, and `invalid_url` paths against the deployed Worker. Update the README to describe the validated flows.

#### 2026-04-13 — Second simplify pass and prompt-log reconciliation

**Model**  
Claude Opus 4.6 (Claude Code)

**Prompt**  
Run a second simplify review over the incremental changes since the last pass. Apply only the small, clearly-correct fixes — hoist frequently-used regexes out of hot paths, keep readable branching over forced deduplication. Then reconcile the prompt log so every development-time stage is represented and the log matches the actual commit history in shape and order.

## Suggested future entries

Add entries as development continues for:

- audit summary prompt design
- workflow step design and error handling
- follow-up question prompt templates
- README wording and deployment troubleshooting

## Guidance for future updates

- Record prompts as they are used, not reconstructed at the end.
- Keep each prompt focused on the engineering intent, not on tone or formatting instructions.
- Use separate entries for unrelated prompts, even on the same day.
- Keep development-time models (Claude Opus 4.6, GPT-5.4) distinct from the runtime LLM (Workers AI).
