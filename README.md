# Araviel API

Backend for Araviel, an AI orchestration platform that routes user queries to the optimal AI model. Built with Next.js, TypeScript, and Supabase.

## Overview

Araviel replaces multiple AI subscriptions with a single intelligent interface. When a user sends a message, the backend:

1. Calls the **Araviel Decision Engine (ADE)** to determine the best AI model for that query
2. Routes the request to the selected provider (OpenAI, Anthropic, Google, or Perplexity)
3. Streams the response back via **Server-Sent Events (SSE)**

```
Client -> POST /api/chat -> ADE (routing) -> AI Provider (stream) -> SSE -> Client
```

## Architecture

```
src/
  app/
    api/
      chat/route.ts               # Main streaming chat endpoint
      conversations/
        route.ts                   # List and create conversations
        [id]/
          route.ts                 # Get single conversation
          messages/
            route.ts               # Get messages for a conversation
            [messageId]/
              sub-conversations/
                route.ts           # Create and list sub-conversations for a message
      sub-conversations/
        [subId]/
          messages/route.ts        # Get messages for a sub-conversation
      health/route.ts              # Health check
      cors.ts                      # CORS configuration
  lib/
    supabase.ts                    # Supabase client
    ade.ts                         # ADE client
    cost.ts                        # Token cost calculator
    chat-helpers.ts                # Chat endpoint helper functions
    types.ts                       # Shared TypeScript types
    providers/
      base.ts                      # Provider interface
      index.ts                     # Provider registry
      openai.ts                    # OpenAI (Responses API)
      anthropic.ts                 # Anthropic (Messages API)
      gemini.ts                    # Google Gemini (GenAI SDK)
      perplexity.ts                # Perplexity (OpenAI-compatible)
    stream/
      normalizer.ts                # SSE stream utilities
  config/
    models.ts                      # Model pricing configuration
```

## Tech Stack

- **Runtime**: Next.js 16 (App Router)
- **Language**: TypeScript (strict mode)
- **Database**: Supabase (Postgres)
- **AI Providers**: OpenAI, Anthropic, Google Gemini, Perplexity
- **Deployment**: Vercel

## Prerequisites

- Node.js 18+
- npm
- A Supabase project with the required tables (see Database section)
- API keys for the AI providers you want to use

## Setup

1. Clone the repository:

```bash
git clone <repository-url>
cd araviel-api
```

2. Install dependencies:

```bash
npm install
```

3. Create a `.env` file in the project root:

```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
ADE_BASE_URL=https://ade-sandy.vercel.app
OPENAI_API_KEY=your_openai_key
ANTHROPIC_API_KEY=your_anthropic_key
GOOGLE_API_KEY=your_google_key
PERPLEXITY_API_KEY=your_perplexity_key
```

4. Start the development server:

```bash
npm run dev
```

The API will be available at `http://localhost:3000`.

## Database Schema

Five tables are required in Supabase. Create them before running the API.

### conversations

| Column     | Type        | Description          |
| ---------- | ----------- | -------------------- |
| id         | text (PK)   | UUID                 |
| title      | text        | Conversation title   |
| created_at | timestamptz | Creation timestamp   |
| updated_at | timestamptz | Last update timestamp|

### messages

| Column               | Type        | Description                                      |
| -------------------- | ----------- | ------------------------------------------------ |
| id                   | text (PK)   | UUID                                             |
| conversation_id      | text (FK)   | References conversations.id                      |
| sub_conversation_id  | text (FK)   | References sub_conversations.id (nullable)       |
| role                 | text        | "user" or "assistant"                            |
| content              | text        | Message content                                  |
| model_used           | jsonb       | ADE routing result (assistant messages)          |
| tokens_input         | int4        | Input token count                                |
| tokens_output        | int4        | Output token count                               |
| tokens_reasoning     | int4        | Reasoning token count                            |
| tokens_cached        | int4        | Cached token count                               |
| cost_usd             | numeric     | Cost in USD                                      |
| latency_ms           | int4        | Provider response latency                        |
| ade_latency_ms       | int4        | ADE routing latency                              |
| extended_data        | jsonb       | Thinking content, citations, etc.                |
| tool_calls           | jsonb       | Tool call data                                   |
| tool_call_id         | text        | Tool call identifier                             |
| attachments          | jsonb       | File attachments                                 |
| created_at           | timestamptz | Creation timestamp                               |

When `sub_conversation_id` is NULL, the message belongs to the main conversation thread. When set, it belongs to a sub-conversation.

### sub_conversations

| Column            | Type        | Description                          |
| ----------------- | ----------- | ------------------------------------ |
| id                | text (PK)   | UUID                                 |
| conversation_id   | text (FK)   | References conversations.id          |
| parent_message_id | text (FK)   | References messages.id               |
| highlighted_text  | text        | The text the user selected/highlighted |
| created_at        | timestamptz | Creation timestamp                   |
| updated_at        | timestamptz | Last update timestamp                |

Sub-conversations are created when a user highlights text in an assistant message and starts a follow-up thread about that specific text. Each sub-conversation is anchored to the parent message it originated from.

### routing_logs

| Column            | Type        | Description                |
| ----------------- | ----------- | -------------------------- |
| id                | text (PK)   | UUID                       |
| message_id        | text (FK)   | References messages.id     |
| prompt            | text        | Original user prompt       |
| recommended_model | jsonb       | ADE primary recommendation |
| alternative_models| jsonb       | ADE backup models          |
| analysis          | jsonb       | ADE query analysis         |
| scoring_breakdown | jsonb       | ADE scoring details        |
| ade_latency_ms    | int4        | ADE response latency       |
| created_at        | timestamptz | Creation timestamp         |

### api_call_logs

| Column        | Type        | Description            |
| ------------- | ----------- | ---------------------- |
| id            | text (PK)   | UUID                   |
| message_id    | text (FK)   | References messages.id |
| provider      | text        | AI provider name       |
| model_id      | text        | Model identifier       |
| status_code   | int4        | HTTP status code       |
| latency_ms    | int4        | Response latency       |
| error_message | text        | Error details if any   |
| retry_count   | int4        | Number of retries      |
| created_at    | timestamptz | Creation timestamp     |

## API Endpoints

### POST /api/chat

Main streaming chat endpoint. Accepts a message, routes it through ADE, calls the selected AI provider, and streams the response via SSE.

**Request body:**

```json
{
  "message": "How do I optimize a React component?",
  "conversationId": "optional-uuid",
  "subConversationId": "optional-uuid",
  "userTier": "free",
  "modality": "text",
  "selectedModelId": "optional-model-id"
}
```

When `subConversationId` is provided, the message is saved as part of that sub-conversation thread. The conversation history sent to the AI provider will include the highlighted text as context.

**Response:** Server-Sent Events stream with the following event types:

| Event      | Description                                    |
| ---------- | ---------------------------------------------- |
| `routing`  | ADE routing decision with model info           |
| `thinking` | Reasoning/thinking tokens (streaming)          |
| `delta`    | Response text tokens (streaming)               |
| `citations`| Web search citations                           |
| `tool_use` | Tool activity (web search in progress)         |
| `done`     | Stream complete with usage stats               |
| `error`    | Error information                              |

### GET /api/conversations

List all conversations with pagination.

**Query params:** `limit` (default 20), `offset` (default 0)

### POST /api/conversations

Create a new conversation.

**Request body:** `{ "title": "optional title" }`

### GET /api/conversations/[id]

Get a single conversation by ID.

### GET /api/conversations/[id]/messages

Get all messages for a conversation with pagination. Only returns main conversation messages (sub-conversation messages are excluded).

**Query params:** `limit` (default 50), `offset` (default 0)

### POST /api/conversations/[id]/messages/[messageId]/sub-conversations

Create a sub-conversation anchored to a specific assistant message.

**Request body:**

```json
{
  "highlightedText": "The text the user selected"
}
```

**Response:** `{ id, conversationId, parentMessageId, highlightedText, createdAt, updatedAt }`

### GET /api/conversations/[id]/messages/[messageId]/sub-conversations

List all sub-conversations for a specific message.

**Response:** `{ subConversations: [{ id, conversationId, parentMessageId, highlightedText, createdAt, updatedAt }] }`

### GET /api/sub-conversations/[subId]/messages

Get all messages for a sub-conversation with pagination. Includes the sub-conversation metadata (highlighted text, parent message ID).

**Query params:** `limit` (default 50), `offset` (default 0)

**Response:** `{ subConversation: { id, conversationId, parentMessageId, highlightedText }, messages: [...] }`

### GET /api/health

Health check endpoint. Returns status of Supabase and ADE connectivity.

## Supported AI Providers

| Provider   | SDK                   | API                    | Models                           |
| ---------- | --------------------- | ---------------------- | -------------------------------- |
| OpenAI     | `openai`              | Responses API          | GPT-5, GPT-4.1, o3, o4-mini     |
| Anthropic  | `@anthropic-ai/sdk`   | Messages API           | Claude Opus 4.6, Sonnet 4.6     |
| Google     | `@google/genai`       | generateContentStream  | Gemini 2.5 Pro, 2.5 Flash       |
| Perplexity | `openai` (custom URL) | Chat Completions       | Sonar, Sonar Pro                 |

## Provider Features

- **Extended thinking**: Enabled for Anthropic (Sonnet/Opus) and OpenAI reasoning models when query complexity is "demanding"
- **Web search**: Enabled based on ADE's intent analysis (research, current events, etc.)
- **Automatic fallback**: If the primary model fails, the backend tries the first available backup model from ADE's recommendations
- **Unsupported provider handling**: ADE may recommend models from unsupported providers. The backend automatically falls back to the first backup model from a supported provider.

## SSE Stream Flow

The streaming experience follows this order:

```
1. routing    -> Model selection info (displayed immediately)
2. thinking   -> Reasoning tokens (collapsible thinking block)
3. delta      -> Response text (main content, token by token)
4. citations  -> Web sources (displayed at end)
5. done       -> Final usage stats (cost, latency, tokens)
```

## Scripts

```bash
npm run dev     # Start development server
npm run build   # Production build
npm run start   # Start production server
npm run lint    # Run ESLint
```

## Deployment

This project is designed for deployment on Vercel:

1. Connect your repository to Vercel
2. Set all environment variables in the Vercel dashboard
3. Deploy

The `maxDuration` for the chat endpoint is set to 60 seconds to accommodate streaming responses.

## License

ISC
