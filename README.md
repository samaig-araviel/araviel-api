# Araviel API

The backend for Araviel — an AI platform that routes each message to the model best suited to answer it and streams the response back in real time.

[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript)](https://www.typescriptlang.org/)

---

## Overview

When a client sends a message, the API:

1. Asks the **Araviel Decision Engine (ADE)** which model fits the query best
2. Calls the selected provider
3. Streams the response back to the client as it's generated
4. Persists the conversation and usage data

```
Client ──▶ Araviel API ──▶ ADE (pick model) ──▶ Provider (stream) ──▶ Client
```

Alongside chat, it handles conversations, projects, image generation, sharing, billing, and account settings.

---

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Language**: TypeScript (strict)
- **Database**: Supabase (Postgres)
- **AI providers**: OpenAI, Anthropic, Google Gemini, Perplexity
- **Billing**: Stripe
- **Deployment**: Vercel

---

## Getting Started

### Prerequisites

- Node.js 18+
- npm
- A Supabase project
- API credentials for the providers you want to enable

### Install

```bash
git clone https://github.com/samaig-araviel/araviel-api.git
cd araviel-api
npm install
```

### Environment

Create a `.env` file with the values for your deployment. Ask your team for the secrets — never commit them. You'll need credentials for:

- **Supabase** — project URL and service role key
- **ADE** — base URL of your ADE deployment
- **Providers** — keys for the AI providers you want to enable
- **Stripe** *(optional)* — only if billing is turned on

### Run

```bash
npm run dev      # start the dev server at http://localhost:3000
npm run build    # production build
npm start        # run the production build
npm test         # run the test suite
npm run lint     # lint
```

---

## API Surface

All endpoints live under `/api`. The core endpoint is:

- **`POST /api/chat`** — send a message and receive a streamed response over Server-Sent Events (SSE)

The rest of the surface covers conversations, projects, images, shares, credits, subscriptions, settings, and a `GET /api/health` check. Detailed request/response shapes are documented separately.

---

## Deployment

Built for Vercel: connect the repository, set the environment variables in the project dashboard, and deploy. The chat endpoint allows for longer execution to support streaming responses.
