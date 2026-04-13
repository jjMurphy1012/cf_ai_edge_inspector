# cf_ai_edge_inspector

An AI-powered website audit agent built on Cloudflare. Users can submit a URL through a chat interface, trigger a multi-step audit workflow, review structured findings, and ask follow-up questions based on persisted scan history.

## Why this project

This project is designed for Cloudflare's AI app assignment and intentionally uses Cloudflare-native building blocks for AI inference, workflow orchestration, stateful coordination, and deployment.

## Assignment coverage

| Requirement                  | How this project satisfies it                    |
| ---------------------------- | ------------------------------------------------ |
| LLM                          | Cloudflare Workers AI                            |
| Workflow / coordination      | Cloudflare Workflows plus Agents/Durable Objects |
| User input via chat or voice | Chat UI                                          |
| Memory or state              | Durable Objects state and persisted scan history |

## Planned architecture

- `Workers AI` generates summaries, prioritizes findings, and answers follow-up questions.
- `Agents SDK` provides the stateful chat agent entry point.
- `Durable Objects` persist audit state, progress, and scan history.
- `Workflows` execute the website audit as a durable multi-step job.
- `Workers` host the application and expose the deployed link.

## Planned user flow

1. A user opens the app and submits a URL in chat.
2. The agent validates the URL and starts an audit workflow.
3. The workflow fetches the site, inspects response behavior and headers, and produces structured findings.
4. Workers AI turns those findings into a concise summary and remediation plan.
5. The app stores the result and lets the user continue the conversation with follow-up questions.

## Current implementation status

The generic starter has been converted into the first project-specific skeleton:

- `AuditAgent` replaces the default demo `ChatAgent`
- `WebsiteAuditWorkflow` is registered in `wrangler.jsonc`
- audit types and scan status enums live in `src/types.ts`
- the workflow performs a lightweight homepage fetch, header inspection, metadata extraction, and AI summary generation
- the frontend now exposes synced Agent state for audit progress
- completed audit results are persisted in the Agent's SQLite-backed SQL store

## AI-assisted development

AI-assisted coding was used during planning and implementation. The primary tools used for this project are:

- `Claude Opus 4.6` via Claude Code
- `GPT-5.4` via Codex

Detailed prompts, usage notes, and outcomes will be documented in [PROMPTS.md](./PROMPTS.md).

## Local development

Prerequisites:

1. Install dependencies.
2. Authenticate with Cloudflare using Wrangler.

Commands:

```bash
npm install
npx wrangler login
npm run types
npm run dev
```

Notes:

- Local dev currently requires `wrangler login` because the `Workers AI` binding uses `"remote": true`.
- If `wrangler.jsonc` changes, rerun `npm run types` to refresh `env.d.ts`.

## Deployment

Live deployment:

- `https://cf-ai-edge-inspector.zheng-jiaju.workers.dev`

Expected deploy flow:

```bash
npm run deploy
```

Deployment status:

- deployed successfully to Cloudflare Workers
- `workers.dev` root returns `HTTP 200`
- bound resources confirmed during deploy:
  - `AuditAgent` Durable Object
  - `WebsiteAuditWorkflow`
  - `Workers AI`

## Status

Project-specific scaffold is live. The next milestones are deeper audit coverage, more refined follow-up reasoning, and final README polish for submission.
