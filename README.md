# Araviel API

Backend for Araviel, an AI orchestration platform that routes each message to the optimal model and streams the response back to the client.

---

## Overview

When a client sends a chat message, the API:

1. Asks the **Araviel Decision Engine (ADE)** which model fits the query best
2. Calls the selected provider (OpenAI, Anthropic, Google, or Perplexity)
3. Streams tokens back to the client over **Server-Sent Events**
4. Persists the conversation and usage metadata in Supabase

```
Client ──▶ /api/chat ──▶ ADE (route) ──▶ Provider (stream) ──▶ SSE ──▶ Client
                                                │
                                                └──▶ Supabase (persist)
```

---

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Language**: TypeScript (strict)
- **Database**: Supabase (Postgres)
- **Providers**: OpenAI, Anthropic, Google Gemini, Perplexity
- **Billing**: Stripe (subscriptions and credit packs)
- **Deployment**: Vercel

---

## Setup

### Prerequisites

- Node.js 18+
- npm
- A Supabase project (see `src/migrations/` for the schema)
- API credentials for the providers you want to enable

### Install

```bash
git clone <repository-url>
cd araviel-api
npm install
```

### Environment

Create a `.env` file with the variables needed for your deployment. Obtain the values from your team — never commit them.

Required categories:

- **Supabase**: project URL and service role key
- **ADE**: base URL of your ADE deployment
- **Providers**: credentials for OpenAI, Anthropic, Google, and/or Perplexity
- **Stripe** _(optional)_: keys and webhook secret if billing is enabled

### Run

```bash
npm run dev      # http://localhost:3000
npm run build    # production build
npm start        # run production build
npm run lint     # eslint
npm test         # vitest
```

---

## API Surface

All endpoints live under `/api`.

| Area            | Endpoints                                                        |
| --------------- | ---------------------------------------------------------------- |
| Chat            | `POST /chat` (SSE stream)                                        |
| Conversations   | `/conversations`, `/conversations/[id]`, `.../messages`          |
| Sub-threads     | `.../messages/[messageId]/sub-conversations`, `/sub-conversations/[id]/messages` |
| Images          | `/images` — image generation and retrieval                       |
| Projects        | `/projects` — project grouping for conversations                 |
| Shares          | `/shares` — public read-only conversation snapshots              |
| Credits         | `/credits` — credit balance and usage                            |
| Subscription    | `/subscription` — subscription status and plan                   |
| Stripe          | `/stripe` — checkout and webhook handlers                        |
| Settings        | `/settings` — user preferences                                   |
| Avatar          | `/avatar` — avatar upload and retrieval                          |
| Health          | `GET /health` — status of Supabase and ADE                       |
| Cron            | `/cron` — scheduled maintenance jobs                             |

### Chat stream events

`POST /api/chat` returns an SSE stream. The ordered event types are:

| Event      | Purpose                                             |
| ---------- | --------------------------------------------------- |
| `routing`  | ADE's model decision and routing metadata           |
| `thinking` | Reasoning tokens (when the model supports them)     |
| `delta`    | Response text, token by token                       |
| `tool_use` | Tool activity (e.g. web search in progress)         |
| `citations`| Web search citations                                |
| `done`     | Final usage: tokens, cost, latency                  |
| `error`    | Error payload                                       |

---

## Project Structure

```
src/
├── app/api/         # Route handlers (chat, conversations, images, stripe, ...)
├── lib/
│   ├── ade.ts       # ADE client
│   ├── supabase.ts  # Supabase client
│   ├── providers/   # OpenAI, Anthropic, Gemini, Perplexity adapters
│   ├── stream/      # SSE normalizer
│   └── ...          # auth, cost, credits, rate limit, logger, etc.
├── config/          # Model pricing
└── migrations/      # Supabase SQL migrations
```

---

## Provider Behavior

- **Extended thinking** — enabled for reasoning-capable models when ADE flags the query as demanding
- **Web search** — enabled when ADE detects research or current-events intent
- **Automatic fallback** — if the primary model fails, the first viable backup from ADE's recommendations is used
- **Unsupported providers** — if ADE recommends a provider not enabled here, the backend falls back to the first backup from a supported provider

---

## Deployment

Built for Vercel. Connect the repository, set environment variables in the project dashboard, and deploy. The chat endpoint uses `maxDuration: 60` to accommodate streaming.
