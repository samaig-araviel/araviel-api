# Araviel API

The backend for Araviel — an AI platform that routes each message to the model best suited to answer it, streams the response back in real time, and persists conversation, billing, and project data.

[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript)](https://www.typescriptlang.org/)

---

## Overview

When a client sends a message, the API typically:

1. Authenticates the caller with a Supabase bearer token
2. Asks the **Araviel Decision Engine (ADE)** which model/provider strategy fits the request best
3. Calls the selected provider and streams the response back over **Server-Sent Events (SSE)**
4. Persists the conversation, routing decision, usage, and credit/subscription effects

```text
Client ──▶ Araviel API ──▶ ADE (pick model) ──▶ Provider (stream) ──▶ Client
```

Alongside chat, the API also handles projects, imported conversations, threaded sub-conversations, image generation, shares, credits, subscriptions, avatars, settings, and operational health/cron endpoints.

---

## Features

- **ADE-based model routing** with provider availability awareness
- **Streaming chat responses** over SSE
- **Conversation persistence** with trash, restore, purge, sharing, and reporting flows
- **Threaded sub-conversations** and imported conversation history
- **Image generation** and image-aware chat flows
- **Credits + subscription enforcement** for free, lite, and pro tiers
- **Stripe checkout, portal, and webhook handling**
- **Health checks and scheduled maintenance jobs** for guest cleanup and trash purging

---

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Language**: TypeScript (strict)
- **Database/Auth**: Supabase (Postgres + Auth)
- **AI providers**: OpenAI, Anthropic, Google Gemini, Perplexity, Stability AI
- **Billing**: Stripe
- **Deployment**: Vercel

---

## Getting Started

### Prerequisites

- Node.js 18+
- npm
- A Supabase project
- ADE service credentials
- API credentials for the providers you want to enable
- Stripe credentials if you want subscriptions, checkout flows, or image credit packs

### Install

```bash
git clone https://github.com/samaig-araviel/araviel-api.git
cd araviel-api
npm install
```

### Environment

Create a `.env` file for your deployment. Do **not** commit secrets.

#### Required for the API to start

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Used to validate user bearer tokens against Supabase Auth |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role access for server-side writes, jobs, and admin operations |
| `ADE_JWT_PRIVATE_KEY_CURRENT` | Base64-encoded Ed25519 private key used to sign ADE service JWTs |
| `ADE_JWT_KID_CURRENT` | Key ID attached to ADE JWTs |
| `ADE_CALLER_SECRET_CURRENT` | Shared caller secret sent on outbound ADE requests |

#### Optional / feature-based

| Variable | When to set it | Purpose |
| --- | --- | --- |
| `ADE_BASE_URL` | When not using the default ADE deployment | Override the ADE base URL |
| `OPENAI_API_KEY` | If OpenAI-backed models are enabled | Provider access |
| `ANTHROPIC_API_KEY` | If Anthropic-backed models are enabled | Provider access |
| `GOOGLE_API_KEY` | If Gemini-backed models are enabled | Provider access |
| `PERPLEXITY_API_KEY` | If Perplexity-backed models are enabled | Provider access |
| `STABILITY_API_KEY` | If dedicated image generation is enabled | Stability AI image generation |
| `STRIPE_SECRET_KEY` | If billing is enabled | Stripe API access |
| `STRIPE_WEBHOOK_SECRET` | If Stripe webhooks are enabled | Verify incoming Stripe events |
| `STRIPE_PRICE_LITE_MONTHLY` | If billing is enabled | Lite monthly price ID |
| `STRIPE_PRICE_LITE_ANNUAL` | If billing is enabled | Lite annual price ID |
| `STRIPE_PRICE_PRO_MONTHLY` | If billing is enabled | Pro monthly price ID |
| `STRIPE_PRICE_PRO_ANNUAL` | If billing is enabled | Pro annual price ID |
| `STRIPE_PRICE_IMAGE_STARTER` | If image packs are enabled | Starter image pack price ID |
| `STRIPE_PRICE_IMAGE_CREATOR` | If image packs are enabled | Creator image pack price ID |
| `STRIPE_PRICE_IMAGE_STUDIO` | If image packs are enabled | Studio image pack price ID |
| `APEX_URL` | If you need explicit frontend redirects | Frontend/base app URL for post-checkout flows |

> Billing is not a thin add-on in this codebase: chat, subscriptions, and image credits are integrated into request handling. If you deploy paid tiers, configure Stripe completely.

### Run

```bash
npm run dev
npm run build
npm start
npm test
npm run lint
```

---

## API Surface

All endpoints live under `/api`.

### Core

- **`POST /api/chat`** — primary chat endpoint; authenticates the user, calls ADE, and streams the assistant response over SSE
- **`GET /api/health`** — health check for core dependencies

### Major route groups

- **`/api/conversations`** — conversation CRUD, messages, trash, restore, purge, sharing, reporting
- **`/api/sub-conversations`** — threaded conversation branches and reporting
- **`/api/imported-conversations`** — import, list, inspect, and delete imported chat history
- **`/api/projects`** — project CRUD and project-scoped instructions
- **`/api/images`** — generated image listing and deletion
- **`/api/shares`** — shared/public conversation access
- **`/api/settings`** — user settings and preferences
- **`/api/credits`** — image credit balance and related actions
- **`/api/subscription`** — subscription tier and text/image credit state
- **`/api/stripe`** — checkout, portal, checkout-pack, and webhook flows
- **`/api/models/catalog`** — available model catalog from ADE
- **`/api/avatar`** — avatar upload/delete
- **`/api/client-errors`** — client-side error ingestion
- **`/api/cron/*`** — scheduled maintenance endpoints for deployment cron jobs

### Auth expectations

- Most user endpoints expect `Authorization: Bearer <supabase-jwt>`
- Public/share-style routes and health checks may be accessible without a user token
- Stripe webhooks use signature verification instead of user auth

---

## Runtime Notes

- The chat route runs on the **Node.js runtime**
- Streaming responses are sent as **SSE**
- The chat endpoint is configured with a **300 second max duration** to support long-running streamed responses and provider fallback behavior

---

## Deployment

Built for Vercel: connect the repository, configure the environment variables in the project dashboard, and deploy.

This project also uses **Vercel Cron Jobs** for maintenance:

- `GET /api/cron/cleanup-guest-data` — daily guest-data cleanup
- `GET /api/cron/purge-deleted-conversations` — daily permanent purge of expired soft-deleted conversations

If you deploy outside Vercel, make sure your platform supports:

- Next.js App Router API routes
- long-lived Node.js streaming responses
- scheduled HTTP jobs for maintenance endpoints
