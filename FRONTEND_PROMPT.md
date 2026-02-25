# Araviel Frontend — Full Backend Integration Prompt

> Paste this entire prompt into Claude Code running inside the `araviel-web` repository.

---

## CRITICAL: Read before doing anything

Before making ANY changes, you must thoroughly analyse the existing frontend codebase:

1. Read every file in the `src/` directory. Understand the component tree, state management approach, styling system, routing, and existing API integration patterns.
2. Identify the existing API service layer — how requests are made, how SSE streams are consumed, how errors are handled.
3. Understand the existing design system — colors, spacing, typography, component patterns, animations. Do NOT change the visual design unless a feature requires new UI.
4. Check what already works. Some of the features described below may already be partially or fully implemented. Do not rewrite working code.
5. Follow existing patterns and conventions exactly — file naming, folder structure, import style, state management approach, component composition patterns.

**Rules:**
- Do NOT change anything that already works correctly
- Do NOT refactor existing code unless a change specifically requires it
- Do NOT change styling, layout, or design of existing components
- Do NOT add libraries or dependencies unless absolutely necessary (and ask first)
- Only add or modify what is needed to make the frontend fully functional against the backend API described below
- Keep all changes minimal and surgical

---

## 1. Backend Base URL

| Environment | URL |
|---|---|
| Production | `https://araviel-api.vercel.app` (or whatever the deployed API URL is) |
| Development | `http://localhost:3000` |

The frontend runs on `http://localhost:5173` in development and `https://araviel-web.vercel.app` in production. CORS is configured on the backend to allow both origins.

**Allowed HTTP methods:** GET, POST, OPTIONS
**Allowed headers:** Content-Type

---

## 2. Complete API Endpoints

### 2.1 Health Check

```
GET /api/health
```

**Response (200):**
```json
{
  "status": "ok",
  "timestamp": "2026-02-25T12:00:00.000Z",
  "services": {
    "supabase": true,
    "ade": true
  }
}
```

**Response (503 — degraded):**
```json
{
  "status": "degraded",
  "timestamp": "...",
  "services": {
    "supabase": true,
    "ade": false
  }
}
```

Use this to show a connection status indicator if you want. Not required for core functionality.

---

### 2.2 List Conversations

```
GET /api/conversations?limit=20&offset=0
```

**Query params:**
- `limit` — integer, default 20, max 100
- `offset` — integer, default 0

**Response (200):**
```json
{
  "conversations": [
    {
      "id": "uuid-string",
      "title": "How do I optimize React?",
      "createdAt": "2026-02-25T10:00:00.000Z",
      "updatedAt": "2026-02-25T10:05:00.000Z"
    }
  ],
  "total": 42
}
```

Conversations are sorted by `updatedAt` descending (most recently active first).

---

### 2.3 Create Conversation

```
POST /api/conversations
Content-Type: application/json

{
  "title": "optional title"
}
```

If `title` is omitted or empty, defaults to `"New conversation"`.

**Response (201):**
```json
{
  "id": "uuid-string",
  "title": "My conversation",
  "createdAt": "2026-02-25T10:00:00.000Z",
  "updatedAt": "2026-02-25T10:00:00.000Z"
}
```

**Note:** You do NOT need to call this before sending a chat message. The `POST /api/chat` endpoint auto-creates a conversation if no `conversationId` is provided. It uses the first 50 characters of the message as the title. Only call this endpoint if the frontend needs explicit conversation creation (e.g. a "New Chat" button that creates an empty conversation before the user types).

---

### 2.4 Get Single Conversation

```
GET /api/conversations/:id
```

**Response (200):**
```json
{
  "id": "uuid-string",
  "title": "How do I optimize React?",
  "createdAt": "2026-02-25T10:00:00.000Z",
  "updatedAt": "2026-02-25T10:05:00.000Z"
}
```

**Response (404):**
```json
{
  "error": "Conversation not found"
}
```

---

### 2.5 Get Conversation Messages

```
GET /api/conversations/:id/messages?limit=50&offset=0
```

**Query params:**
- `limit` — integer, default 50, max 200
- `offset` — integer, default 0

**IMPORTANT:** This endpoint only returns main-thread messages. Sub-conversation messages are excluded (filtered by `sub_conversation_id IS NULL`).

Messages are sorted by `created_at` ascending (oldest first — chronological order).

**Response (200):**
```json
{
  "messages": [
    {
      "id": "uuid-string",
      "conversationId": "uuid-string",
      "role": "user",
      "content": "How do I optimize React?",
      "createdAt": "2026-02-25T10:00:00.000Z"
    },
    {
      "id": "uuid-string",
      "conversationId": "uuid-string",
      "role": "assistant",
      "content": "Here are several strategies for optimizing React...",
      "createdAt": "2026-02-25T10:00:05.000Z",
      "model": {
        "id": "claude-sonnet-4-6",
        "name": "Claude Sonnet 4.6",
        "provider": "anthropic",
        "score": 0.92,
        "reasoning": "Best for technical coding questions"
      },
      "alternateModels": [
        {
          "id": "gpt-4.1",
          "name": "GPT-4.1",
          "provider": "openai",
          "score": 0.88,
          "reasoning": "Strong general-purpose model"
        }
      ],
      "thinkingContent": "Let me analyze the React optimization strategies...",
      "citations": [
        { "url": "https://react.dev/reference/react/useMemo", "title": "useMemo – React" }
      ],
      "usage": {
        "inputTokens": 150,
        "outputTokens": 420,
        "reasoningTokens": 80,
        "cachedTokens": 0
      },
      "costUsd": 0.002145,
      "latencyMs": 3200,
      "adeLatencyMs": 180
    }
  ]
}
```

**Field details for assistant messages:**

| Field | Type | Nullable | Description |
|---|---|---|---|
| `model` | `ModelInfo` | Yes | The AI model that generated this response |
| `alternateModels` | `ModelInfo[]` | Yes | Backup models ADE considered |
| `thinkingContent` | `string` | Yes | Extended thinking/reasoning (only for "demanding" complexity queries with thinking-capable models) |
| `citations` | `Citation[]` | Yes | Web search results (only when web search was enabled) |
| `usage.inputTokens` | `number` | — | Tokens in the prompt |
| `usage.outputTokens` | `number` | — | Tokens in the response |
| `usage.reasoningTokens` | `number` | — | Reasoning/thinking tokens consumed |
| `usage.cachedTokens` | `number` | — | Tokens served from cache |
| `costUsd` | `number` | Yes | Cost in USD for this message |
| `latencyMs` | `number` | Yes | Time the AI provider took to respond |
| `adeLatencyMs` | `number` | Yes | Time ADE took to route the query |

User messages only have: `id`, `conversationId`, `role`, `content`, `createdAt`.

---

### 2.6 Create Sub-Conversation

```
POST /api/conversations/:id/messages/:messageId/sub-conversations
Content-Type: application/json

{
  "highlightedText": "The text the user selected from an assistant message"
}
```

`highlightedText` is required and must be a non-empty string.

**Response (201):**
```json
{
  "id": "sub-conv-uuid",
  "conversationId": "parent-conv-uuid",
  "parentMessageId": "msg-uuid",
  "highlightedText": "The text the user selected",
  "createdAt": "2026-02-25T10:10:00.000Z",
  "updatedAt": "2026-02-25T10:10:00.000Z"
}
```

**Response (400):**
```json
{
  "error": "highlightedText is required and must be a non-empty string"
}
```

**Response (404):**
```json
{
  "error": "Parent message not found in this conversation"
}
```

---

### 2.7 List Sub-Conversations for a Message

```
GET /api/conversations/:id/messages/:messageId/sub-conversations
```

**Response (200):**
```json
{
  "subConversations": [
    {
      "id": "sub-conv-uuid",
      "conversationId": "parent-conv-uuid",
      "parentMessageId": "msg-uuid",
      "highlightedText": "Selected text snippet",
      "createdAt": "2026-02-25T10:10:00.000Z",
      "updatedAt": "2026-02-25T10:15:00.000Z"
    }
  ]
}
```

Returns an empty array if no sub-conversations exist for that message.

---

### 2.8 Get Sub-Conversation Messages

```
GET /api/sub-conversations/:subId/messages?limit=50&offset=0
```

**Query params:**
- `limit` — integer, default 50, max 200
- `offset` — integer, default 0

**Response (200):**
```json
{
  "subConversation": {
    "id": "sub-conv-uuid",
    "conversationId": "parent-conv-uuid",
    "parentMessageId": "msg-uuid",
    "highlightedText": "The selected text"
  },
  "messages": [
    {
      "id": "msg-uuid",
      "conversationId": "parent-conv-uuid",
      "subConversationId": "sub-conv-uuid",
      "role": "user",
      "content": "Can you explain this in more detail?",
      "createdAt": "2026-02-25T10:10:05.000Z"
    },
    {
      "id": "msg-uuid",
      "conversationId": "parent-conv-uuid",
      "subConversationId": "sub-conv-uuid",
      "role": "assistant",
      "content": "Sure, let me break that down...",
      "createdAt": "2026-02-25T10:10:10.000Z",
      "model": { "id": "...", "name": "...", "provider": "...", "score": 0.9, "reasoning": "..." },
      "alternateModels": [...],
      "thinkingContent": null,
      "citations": null,
      "usage": { "inputTokens": 100, "outputTokens": 250, "reasoningTokens": 0, "cachedTokens": 0 },
      "costUsd": 0.001,
      "latencyMs": 2100,
      "adeLatencyMs": 150
    }
  ]
}
```

**Response (404):**
```json
{
  "error": "Sub-conversation not found"
}
```

Note: sub-conversation messages always include `subConversationId` (never null).

---

### 2.9 Streaming Chat — POST /api/chat (SSE)

This is the main chat endpoint. It accepts a message, routes through the Araviel Decision Engine (ADE), calls the selected AI provider, and streams the response via Server-Sent Events.

```
POST /api/chat
Content-Type: application/json
```

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

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `message` | `string` | **Yes** | — | The user's message. Must be non-empty. |
| `conversationId` | `string` | No | auto-created | If omitted, a new conversation is created with the first 50 chars of the message as the title. |
| `subConversationId` | `string` | No | `undefined` | If set, the message is part of a sub-conversation thread. The backend will include the highlighted text as context for the AI. |
| `userTier` | `string` | No | `"free"` | User tier, passed to ADE for model selection. |
| `modality` | `string` | No | `"text"` | Request modality, passed to ADE. |
| `selectedModelId` | `string` | No | `undefined` | Manual model override. If set, bypasses ADE's recommendation and uses this model directly. |

**Response:** `Content-Type: text/event-stream`

Each SSE line is formatted as:
```
data: {"type":"<event_type>","data":{...}}\n\n
```

Parse each line by stripping the `data: ` prefix and JSON-parsing the rest. Each parsed object has `type` and `data` fields.

---

#### SSE Event Types — Complete Reference

**Event 1: `routing`** — Always sent first. Contains the model routing decision.

```json
{
  "type": "routing",
  "data": {
    "conversationId": "uuid",
    "subConversationId": "uuid-or-null",
    "messageId": "uuid",
    "model": {
      "id": "claude-sonnet-4-6",
      "name": "Claude Sonnet 4.6",
      "provider": "anthropic",
      "score": 0.92,
      "reasoning": "Best for technical coding questions"
    },
    "backupModels": [
      {
        "id": "gpt-4.1",
        "name": "GPT-4.1",
        "provider": "openai",
        "score": 0.88,
        "reasoning": "Strong general-purpose model"
      }
    ],
    "analysis": {
      "intent": "code_generation",
      "domain": "programming",
      "complexity": "demanding"
    },
    "confidence": 0.92,
    "adeLatencyMs": 180,
    "isManualSelection": false,
    "upgradeHint": null,
    "providerHint": null
  }
}
```

**Key fields from `routing`:**
- `conversationId` — The conversation ID (may be auto-generated if none was sent). **Save this** — you need it for subsequent messages.
- `subConversationId` — Null for main thread, UUID for sub-conversation messages.
- `messageId` — The assistant message ID (not yet persisted to DB at this point, but will be in `done`). Used for creating sub-conversations later.
- `model` — The selected AI model with its provider, score, and reasoning.
- `backupModels` — Alternative models ADE considered. Display these if you want.
- `analysis.intent` — What ADE thinks the user wants (e.g. `"code_generation"`, `"research"`, `"creative_writing"`, `"factual_lookup"`, `"current_events"`, `"general_chat"`, etc.)
- `analysis.domain` — Subject domain (e.g. `"programming"`, `"science"`, `"business"`, etc.)
- `analysis.complexity` — Either `"simple"`, `"standard"`, or `"demanding"`. Demanding queries trigger extended thinking on capable models.
- `confidence` — 0–1 float. How confident ADE is in its model selection.
- `isManualSelection` — `true` if the user overrode with `selectedModelId`.
- `upgradeHint` — Present when the user's tier limits model access. Structure: `{ recommendedModel: { id, name, provider }, reason: string, scoreDifference: number }`. Use this to show "Upgrade to access [model]" prompts.
- `providerHint` — Present when a better model exists on an unsupported provider. Same structure as upgradeHint.

---

**Event 2: `thinking`** — Streamed token-by-token. Only sent for "demanding" complexity queries on thinking-capable models.

```json
{
  "type": "thinking",
  "data": {
    "content": "Let me analyze "
  }
}
```

Accumulate `data.content` into a thinking buffer. Display as a collapsible "Thinking..." block. These arrive BEFORE `delta` events.

**Thinking-capable models:**
- Anthropic: `claude-sonnet-4-6`, `claude-sonnet-4-5-20250929`, `claude-opus-4-6`, `claude-opus-4-5-20251101`
- OpenAI: `o3`, `o3-pro`, `o4-mini` (these emit reasoning summaries, not raw thinking)
- Google: Gemini 2.5 Pro models (not Flash)

---

**Event 3: `delta`** — Streamed token-by-token. The main response content.

```json
{
  "type": "delta",
  "data": {
    "content": "Here are "
  }
}
```

Accumulate `data.content` into the message body. Render incrementally with markdown support.

---

**Event 4: `citations`** — Sent once near the end, if web search was used.

```json
{
  "type": "citations",
  "data": {
    "citations": [
      { "url": "https://react.dev/learn", "title": "React Documentation" },
      { "url": "https://example.com/article", "title": "Performance Guide" }
    ]
  }
}
```

Display as a list of source links below the response.

**When web search is enabled:** ADE enables web search for intents like `"research"`, `"current_events"`, `"news"`, `"factual_lookup"`, `"fact_checking"`, `"information_retrieval"`.

---

**Event 5: `tool_use`** — Sent when the AI is using a tool (currently only web search).

```json
{
  "type": "tool_use",
  "data": {
    "tool": "web_search",
    "status": "searching"
  }
}
```

Display a brief "Searching the web..." indicator while this is active.

---

**Event 6: `done`** — Sent last. Stream is complete. Contains final statistics.

```json
{
  "type": "done",
  "data": {
    "messageId": "uuid",
    "conversationId": "uuid",
    "subConversationId": "uuid-or-null",
    "usage": {
      "inputTokens": 150,
      "outputTokens": 420,
      "reasoningTokens": 80,
      "cachedTokens": 0,
      "costUsd": 0.002145
    },
    "latencyMs": 3200,
    "adeLatencyMs": 180
  }
}
```

**Key fields from `done`:**
- `messageId` — The persisted assistant message ID. **Save this** — needed for creating sub-conversations on this message.
- `conversationId` — Confirm/update the conversation ID.
- `subConversationId` — Null for main thread, UUID for sub-conversation.
- `usage.costUsd` — Total cost for this message. Display as `$0.0021` or similar.
- `latencyMs` — Total time the AI provider took.
- `adeLatencyMs` — Time ADE routing took.

---

**Event 7: `error`** — Can arrive at any point. Various error codes.

```json
{
  "type": "error",
  "data": {
    "message": "Human-readable error message",
    "code": "ERROR_CODE",
    "category": "optional-category",
    "suggestedPlatforms": ["optional-array"]
  }
}
```

**Error codes and how to handle them:**

| Code | Meaning | Frontend Handling |
|---|---|---|
| `INTERNAL_ERROR` | Unexpected server error | Show generic error message, allow retry |
| `UNSUPPORTED_TASK` | ADE says no model can handle this | Show the `message`. Optionally show `suggestedPlatforms` (e.g. "Try Midjourney for image generation") |
| `NO_PROVIDER` | No supported provider available | Show error, suggest trying a different query |
| `PROVIDER_RETRY` | Primary model failed, retrying with backup | Show as info/warning, NOT as a fatal error. The stream will continue with a backup model. |
| `PROVIDER_ERROR` | Provider failed, no backup available | Show error, allow retry |
| `ALL_PROVIDERS_FAILED` | Both primary and backup failed | Show error, allow retry |

**IMPORTANT:** `PROVIDER_RETRY` is NOT terminal. The stream continues after it. Do not close the stream or show a fatal error on `PROVIDER_RETRY`. Just show an informational message like "Retrying with backup model..." and keep listening.

---

## 3. SSE Stream Consumption Pattern

The SSE format is NOT standard EventSource-compatible (it uses `data:` lines only, no `event:` field). You need to consume it as a `fetch` response with `ReadableStream`.

Here is the exact pattern the frontend should use:

```typescript
const response = await fetch(`${API_BASE_URL}/api/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    message: "user message",
    conversationId: conversationId || undefined,
    subConversationId: subConversationId || undefined,
    userTier: "free",
    modality: "text",
    selectedModelId: selectedModelId || undefined,
  }),
});

if (!response.ok) {
  // HTTP-level error (not SSE). Handle as fatal.
  throw new Error(`HTTP ${response.status}`);
}

const reader = response.body!.getReader();
const decoder = new TextDecoder();
let buffer = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n\n");
  buffer = lines.pop()!; // Keep incomplete chunk

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data: ")) continue;

    const json = JSON.parse(trimmed.slice(6));
    const { type, data } = json;

    switch (type) {
      case "routing":
        // Save conversationId, messageId, display model info
        break;
      case "thinking":
        // Append data.content to thinking buffer
        break;
      case "delta":
        // Append data.content to message body
        break;
      case "citations":
        // Save data.citations array
        break;
      case "tool_use":
        // Show "Searching the web..." indicator
        break;
      case "done":
        // Save final messageId, usage stats
        break;
      case "error":
        // Handle based on data.code (see error table above)
        break;
    }
  }
}
```

---

## 4. ModelInfo Type

This appears in routing events, message data, and backup models:

```typescript
interface ModelInfo {
  id: string;        // e.g. "claude-sonnet-4-6", "gpt-4.1", "gemini-2.5-pro"
  name: string;      // Human-readable name e.g. "Claude Sonnet 4.6"
  provider: string;  // "openai" | "anthropic" | "google" | "perplexity"
  score: number;     // 0–1 float, ADE confidence score
  reasoning: string; // Why ADE chose this model
}
```

**Supported providers and their models:**

| Provider | Models | Capabilities |
|---|---|---|
| `openai` | GPT-5, GPT-4.1, o3, o4-mini, and variants | Web search, reasoning (o3/o4-mini) |
| `anthropic` | Claude Opus 4.6, Claude Sonnet 4.6, and older variants | Web search, extended thinking |
| `google` | Gemini 2.5 Pro, Gemini 2.5 Flash, and variants | Web search (Google Search), thinking (Pro only) |
| `perplexity` | Sonar, Sonar Pro | Built-in web search with citations |

---

## 5. Citation Type

```typescript
interface Citation {
  url: string;   // The source URL
  title: string; // Human-readable title (may be the URL if title unavailable)
}
```

---

## 6. Sub-Conversation Feature — Full Flow

Sub-conversations allow users to highlight text in an assistant response and start a focused follow-up thread about that specific text.

**Complete flow:**

1. User selects/highlights text within an assistant message's content
2. Frontend shows a floating action (e.g. tooltip, popover) with an "Ask about this" button
3. User clicks it → Frontend calls `POST /api/conversations/:convId/messages/:msgId/sub-conversations` with `{ "highlightedText": "selected text" }`
4. Backend returns the sub-conversation object with its `id`
5. Frontend opens an inline thread UI anchored to that message
6. Frontend shows the highlighted text as context at the top of the thread
7. User types a message → Frontend calls `POST /api/chat` with `{ message: "...", conversationId: "...", subConversationId: "sub-conv-id" }`
8. SSE stream works identically to main chat — same events, same format. The `routing` and `done` events include `subConversationId` instead of `null`.
9. Sub-conversation messages are separate from the main thread (they won't appear in `GET /api/conversations/:id/messages`)

**Loading existing sub-conversations:**

- When rendering an assistant message, call `GET /api/conversations/:id/messages/:messageId/sub-conversations` to check if any sub-conversations exist
- Show a thread count indicator on messages that have sub-conversations
- When user clicks to open a sub-conversation, call `GET /api/sub-conversations/:subId/messages` to load its message history
- The response includes `subConversation.highlightedText` so you can display the context

**Backend behavior for sub-conversation chat:**
- The AI receives the highlighted text as system context: `"The user is asking a follow-up question about this specific text they highlighted from a previous response: \"[highlighted text]\". Respond in the context of this highlighted text."`
- Sub-conversation message history is separate — the AI only sees the sub-conversation's own messages plus the highlighted text context
- History is limited to 20 messages per conversation/sub-conversation

---

## 7. Conversation Auto-Creation

When the user sends their first message without a `conversationId`:
1. The backend auto-creates a conversation
2. The title is set to the first 50 characters of the message (with "..." appended if truncated)
3. The `routing` SSE event returns the new `conversationId`
4. **The frontend must capture this `conversationId` from the `routing` event and use it for all subsequent messages in this conversation**

When the user sends a message WITH a `conversationId`:
- The backend verifies the conversation exists (404 if not)
- No new conversation is created

---

## 8. Manual Model Selection

The frontend can let users manually pick which AI model to use by passing `selectedModelId` in the chat request.

When `selectedModelId` is provided:
- ADE still runs (for analysis/backup models) but the selected model is used instead of ADE's recommendation
- The `routing` event will have `isManualSelection: true`
- If the selected model ID matches one of ADE's recommendations, that model is promoted to primary and the rest become backups
- If the selected model ID does NOT match any ADE recommendation, the backend guesses the provider from the model ID prefix (e.g. `claude-*` → anthropic, `gpt-*`/`o3`/`o4` → openai, `gemini-*` → google, `sonar*` → perplexity)

---

## 9. Upgrade Hints & Provider Hints

The `routing` event may include:

**`upgradeHint`** — A better model exists but the user's tier can't access it:
```json
{
  "upgradeHint": {
    "recommendedModel": {
      "id": "claude-opus-4-6",
      "name": "Claude Opus 4.6",
      "provider": "anthropic"
    },
    "reason": "Opus would handle this complex reasoning task better",
    "scoreDifference": 0.15
  }
}
```
Display this as a subtle suggestion: "For better results, upgrade to access Claude Opus 4.6"

**`providerHint`** — A better model exists on a provider that isn't available:
Same structure. Display as info: "A better model may be available on [provider]"

Both can be `null`. Only show UI for them when they're present.

---

## 10. Error Response Format (Non-SSE)

All REST endpoints (not `/api/chat`) return errors in this format:

```json
{
  "error": "Human-readable error message"
}
```

HTTP status codes used: 400, 404, 500, 503.

---

## 11. Pagination

Two paginated endpoints:
- `GET /api/conversations` — `limit` (default 20, max 100), `offset` (default 0). Returns `total` count.
- `GET /api/conversations/:id/messages` — `limit` (default 50, max 200), `offset` (default 0). No total count returned.
- `GET /api/sub-conversations/:subId/messages` — `limit` (default 50, max 200), `offset` (default 0). No total count returned.

For conversation list, implement infinite scroll or "Load more" using `offset` + `total`.
For messages, load the most recent page first and allow loading older messages.

---

## 12. What the Frontend Must Support — Feature Checklist

Check each against the existing codebase. Only implement what's missing.

### Core Chat
- [ ] Send messages via `POST /api/chat` with SSE streaming
- [ ] Parse all SSE event types correctly (routing, thinking, delta, citations, tool_use, done, error)
- [ ] Display streaming text with markdown rendering
- [ ] Handle `PROVIDER_RETRY` as non-fatal (keep listening)
- [ ] Handle all other error codes appropriately
- [ ] Save `conversationId` from `routing` event for new conversations
- [ ] Save `messageId` from `done` event for sub-conversation creation

### Model Routing Display
- [ ] Show which model is responding (from `routing` event)
- [ ] Show model provider icon/badge (openai, anthropic, google, perplexity)
- [ ] Display ADE analysis (intent, domain, complexity) — can be subtle/collapsible
- [ ] Show confidence score
- [ ] Show backup models (optional, could be in a details popover)
- [ ] Handle `isManualSelection` indicator
- [ ] Display `upgradeHint` when present
- [ ] Display `providerHint` when present

### Extended Thinking
- [ ] Accumulate `thinking` events into a separate buffer
- [ ] Display as a collapsible "Thinking..." block above the response
- [ ] Show thinking content only when it exists (not all responses have it)

### Citations / Web Search
- [ ] Show "Searching the web..." indicator on `tool_use` events
- [ ] Display citations as clickable source links below the response
- [ ] Only show citations section when citations exist

### Usage Statistics
- [ ] Display token usage from `done` event (input, output, reasoning, cached)
- [ ] Display cost (`costUsd`) formatted as dollars
- [ ] Display latency (`latencyMs`) and ADE latency (`adeLatencyMs`)
- [ ] Show this info in a subtle, non-intrusive way (e.g. footer of each message, collapsible)

### Conversation Management
- [ ] List conversations via `GET /api/conversations` with pagination
- [ ] Create new conversations (either explicitly or via auto-creation on first message)
- [ ] Load conversation history via `GET /api/conversations/:id/messages`
- [ ] Switch between conversations
- [ ] Show conversation titles sorted by most recently active

### Sub-Conversations
- [ ] Text selection on assistant messages triggers a floating action
- [ ] Create sub-conversations via `POST .../sub-conversations`
- [ ] Inline thread UI for sub-conversation chat
- [ ] Send sub-conversation messages via `POST /api/chat` with `subConversationId`
- [ ] Load sub-conversation messages via `GET /api/sub-conversations/:subId/messages`
- [ ] Show highlighted text as context at the top of sub-conversation threads
- [ ] Thread count indicators on assistant messages that have sub-conversations
- [ ] List and reopen existing sub-conversations

### Manual Model Selection (Optional but Recommended)
- [ ] UI to manually select a model (dropdown or similar)
- [ ] Pass `selectedModelId` in chat request
- [ ] Show `isManualSelection: true` indicator in the response

---

## 13. TypeScript Types — Copy These

These are the exact shapes the backend sends. Use these types in the frontend:

```typescript
// === API Response Types ===

interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface ConversationListResponse {
  conversations: Conversation[];
  total: number;
}

interface MessageListResponse {
  messages: FormattedMessage[];
}

interface FormattedMessage {
  id: string;
  conversationId: string;
  subConversationId?: string | null;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  // Only present on assistant messages:
  model?: ModelInfo | null;
  alternateModels?: ModelInfo[] | null;
  thinkingContent?: string | null;
  citations?: Citation[] | null;
  usage?: TokenUsage | null;
  costUsd?: number | null;
  latencyMs?: number | null;
  adeLatencyMs?: number | null;
}

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  score: number;
  reasoning: string;
}

interface Citation {
  url: string;
  title: string;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
}

interface SubConversation {
  id: string;
  conversationId: string;
  parentMessageId: string;
  highlightedText: string;
  createdAt: string;
  updatedAt: string;
}

interface SubConversationListResponse {
  subConversations: SubConversation[];
}

interface SubConversationMessagesResponse {
  subConversation: {
    id: string;
    conversationId: string;
    parentMessageId: string;
    highlightedText: string;
  };
  messages: FormattedMessage[];
}

// === SSE Event Types ===

interface SSEEvent {
  type: "routing" | "thinking" | "delta" | "citations" | "tool_use" | "done" | "error";
  data: Record<string, unknown>;
}

interface SSERoutingData {
  conversationId: string;
  subConversationId: string | null;
  messageId: string;
  model: ModelInfo;
  backupModels: ModelInfo[];
  analysis: {
    intent: string;
    domain: string;
    complexity: string;
  };
  confidence: number;
  adeLatencyMs: number;
  isManualSelection: boolean;
  upgradeHint: {
    recommendedModel: { id: string; name: string; provider: string };
    reason: string;
    scoreDifference: number;
  } | null;
  providerHint: {
    recommendedModel: { id: string; name: string; provider: string };
    reason: string;
    scoreDifference: number;
  } | null;
}

interface SSEDoneData {
  messageId: string;
  conversationId: string;
  subConversationId: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cachedTokens: number;
    costUsd: number;
  };
  latencyMs: number;
  adeLatencyMs: number;
}

interface SSEErrorData {
  message: string;
  code: "INTERNAL_ERROR" | "UNSUPPORTED_TASK" | "NO_PROVIDER" | "PROVIDER_RETRY" | "PROVIDER_ERROR" | "ALL_PROVIDERS_FAILED";
  category?: string;
  suggestedPlatforms?: string[];
}

// === Chat Request ===

interface ChatRequest {
  message: string;
  conversationId?: string;
  subConversationId?: string;
  userTier?: string;
  modality?: string;
  selectedModelId?: string;
}

// === Health Check ===

interface HealthResponse {
  status: "ok" | "degraded";
  timestamp: string;
  services: {
    supabase: boolean;
    ade: boolean;
  };
}
```

---

## 14. Important Backend Behaviors to Know

1. **Conversation history limit**: The backend sends the last 20 messages (either main thread or sub-conversation thread) to the AI provider. The frontend doesn't need to handle this, but be aware that very long conversations have truncated context.

2. **Automatic fallback**: If the primary AI model fails, the backend automatically tries the first available backup model. The frontend will receive a `PROVIDER_RETRY` error event followed by continued streaming from the backup model. The `routing` event always shows the initially selected model — if a backup was used, the persisted message's `model` field will reflect the backup.

3. **Sub-conversation isolation**: Sub-conversation messages are completely isolated from the main thread. `GET /api/conversations/:id/messages` never returns sub-conversation messages. The AI in a sub-conversation only sees the highlighted text context + that sub-conversation's messages.

4. **Message ordering**: Messages from the API are always sorted `created_at ASC` (chronological). The frontend should render them in the order received.

5. **Conversation timestamp updates**: Sending a message updates the conversation's `updated_at` timestamp, which affects sort order in the conversation list.

6. **SSE format**: Each event is `data: {json}\n\n`. There are no `event:` or `id:` fields. Do not use the browser `EventSource` API — use `fetch` with `ReadableStream`.

7. **Max streaming duration**: The backend has a 60-second timeout (`maxDuration: 60`). Very long responses may be cut off. The stream will just end without a `done` event in this case. Handle gracefully.

8. **No authentication**: The current backend has no auth. All endpoints are open. Do not implement auth on the frontend unless adding it later.

9. **No DELETE endpoints**: There are no endpoints to delete conversations, messages, or sub-conversations. Do not add delete UI that calls non-existent endpoints.

10. **No PATCH/PUT endpoints**: There are no update endpoints (e.g. rename conversation). Do not add rename UI that calls non-existent endpoints.
