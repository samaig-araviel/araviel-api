import { randomUUID } from "crypto";
import { getSupabase } from "@/lib/supabase";
import type {
  ADEModelResult,
  ADEResponse,
  ChatRequest,
  ConversationMessage,
  DBConversation,
  DBMessage,
  DBSubConversation,
  ModelInfo,
  TokenUsage,
} from "@/lib/types";
import { SUPPORTED_PROVIDERS } from "@/lib/types";
import { getChartInstructions } from "@/lib/prompts/chart-instructions";
import { getMessages as getImportedMessages } from "@/lib/imported-conversations";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateChatRequest(body: unknown): ChatRequest {
  if (!body || typeof body !== "object") {
    throw new Error("Request body is required");
  }

  const req = body as Record<string, unknown>;

  if (!req.message || typeof req.message !== "string" || req.message.trim() === "") {
    throw new Error("message is required and must be a non-empty string");
  }

  let importedConversationId: string | undefined;
  if (typeof req.importedConversationId === "string" && req.importedConversationId.trim()) {
    if (!UUID_RE.test(req.importedConversationId.trim())) {
      throw new Error("importedConversationId must be a valid UUID");
    }
    importedConversationId = req.importedConversationId.trim();
  }

  return {
    conversationId: typeof req.conversationId === "string" ? req.conversationId : undefined,
    subConversationId: typeof req.subConversationId === "string" ? req.subConversationId : undefined,
    importedConversationId,
    projectId: typeof req.projectId === "string" ? req.projectId : undefined,
    message: req.message.trim(),
    userTier: typeof req.userTier === "string" ? req.userTier : "free",
    modality: typeof req.modality === "string" ? req.modality : "text",
    selectedModelId: typeof req.selectedModelId === "string" ? req.selectedModelId : undefined,
    webSearch: typeof req.webSearch === "boolean" ? req.webSearch : undefined,
    tone: typeof req.tone === "string" ? req.tone : undefined,
    mood: typeof req.mood === "string" ? req.mood : undefined,
    autoStrategy: typeof req.autoStrategy === "string" ? req.autoStrategy : undefined,
    weather: typeof req.weather === "string" ? req.weather : undefined,
    conversationHasImages: typeof req.conversationHasImages === "boolean" ? req.conversationHasImages : undefined,
  };
}

export async function getOrCreateConversation(
  conversationId: string | undefined,
  messagePreview: string,
  projectId?: string
): Promise<string> {
  const supabase = getSupabase();

  if (conversationId) {
    const { data, error } = await supabase
      .from("conversations")
      .select("id")
      .eq("id", conversationId)
      .single();

    if (error || !data) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    return conversationId;
  }

  const id = randomUUID();
  const title = messagePreview.slice(0, 50) + (messagePreview.length > 50 ? "..." : "");
  const now = new Date().toISOString();

  const row: Record<string, unknown> = {
    id,
    title,
    created_at: now,
    updated_at: now,
  };

  if (projectId) {
    row.project_id = projectId;
  }

  const { error } = await supabase.from("conversations").insert(row);

  if (error) {
    throw new Error(`Failed to create conversation: ${error.message}`);
  }

  return id;
}

export async function saveUserMessage(
  conversationId: string,
  content: string,
  subConversationId?: string
): Promise<string> {
  const supabase = getSupabase();
  const id = randomUUID();

  const { error } = await supabase.from("messages").insert({
    id,
    conversation_id: conversationId,
    sub_conversation_id: subConversationId ?? null,
    role: "user",
    content,
    created_at: new Date().toISOString(),
  });

  if (error) {
    throw new Error(`Failed to save user message: ${error.message}`);
  }

  return id;
}

export async function insertAssistantMessage(
  messageId: string,
  conversationId: string,
  data: {
    content: string;
    modelUsed: Record<string, unknown>;
    usage: TokenUsage;
    costUsd: number;
    latencyMs: number;
    adeLatencyMs: number;
    extendedData: Record<string, unknown>;
    subConversationId?: string;
  }
): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase.from("messages").insert({
    id: messageId,
    conversation_id: conversationId,
    sub_conversation_id: data.subConversationId ?? null,
    role: "assistant",
    content: data.content,
    model_used: data.modelUsed,
    tokens_input: data.usage.inputTokens,
    tokens_output: data.usage.outputTokens,
    tokens_reasoning: data.usage.reasoningTokens,
    tokens_cached: data.usage.cachedTokens,
    cost_usd: data.costUsd,
    latency_ms: data.latencyMs,
    ade_latency_ms: data.adeLatencyMs,
    extended_data: data.extendedData,
    created_at: new Date().toISOString(),
  });

  if (error) {
    throw new Error(`Failed to insert assistant message: ${error.message}`);
  }
}

export async function updateConversationTimestamp(
  conversationId: string
): Promise<void> {
  const supabase = getSupabase();

  await supabase
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId);
}

export async function saveRoutingLog(
  messageId: string,
  adeResponse: ADEResponse,
  adeLatencyMs: number
): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase.from("routing_logs").insert({
    id: randomUUID(),
    message_id: messageId,
    prompt: "",
    recommended_model: adeResponse.primaryModel,
    alternative_models: adeResponse.backupModels,
    analysis: adeResponse.analysis,
    scoring_breakdown: adeResponse.timing,
    ade_latency_ms: adeLatencyMs,
    created_at: new Date().toISOString(),
  });

  if (error) {
    throw new Error(`Failed to save routing log: ${error.message}`);
  }
}

export async function saveApiCallLog(
  messageId: string,
  provider: string,
  modelId: string,
  statusCode: number,
  latencyMs: number,
  errorMessage?: string,
  retryCount?: number
): Promise<void> {
  const supabase = getSupabase();

  await supabase.from("api_call_logs").insert({
    id: randomUUID(),
    message_id: messageId,
    provider,
    model_id: modelId,
    status_code: statusCode,
    latency_ms: latencyMs,
    error_message: errorMessage ?? null,
    retry_count: retryCount ?? 0,
    created_at: new Date().toISOString(),
  });
}

export async function fetchConversationHistory(
  conversationId: string,
  subConversationId?: string
): Promise<ConversationMessage[]> {
  const supabase = getSupabase();

  if (subConversationId) {
    // For sub-conversations: fetch the highlighted text as context,
    // then return the sub-conversation's own message history
    const { data: subConv } = await supabase
      .from("sub_conversations")
      .select("highlighted_text")
      .eq("id", subConversationId)
      .single();

    const contextMessages: ConversationMessage[] = [];
    if (subConv?.highlighted_text) {
      contextMessages.push({
        role: "system",
        content: `The user is asking a follow-up question about this specific text they highlighted from a previous response:\n\n"${subConv.highlighted_text}"\n\nRespond in the context of this highlighted text.`,
      });
    }

    const { data, error } = await supabase
      .from("messages")
      .select("role, content")
      .eq("sub_conversation_id", subConversationId)
      .order("created_at", { ascending: true })
      .limit(20);

    if (error) {
      throw new Error(`Failed to fetch sub-conversation history: ${error.message}`);
    }

    const messages = (data ?? []).map((msg: Pick<DBMessage, "role" | "content">) => ({
      role: msg.role as ConversationMessage["role"],
      content: msg.content,
    }));

    return [...contextMessages, ...messages];
  }

  // Main conversation: exclude sub-conversation messages
  const { data, error } = await supabase
    .from("messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .is("sub_conversation_id", null)
    .order("created_at", { ascending: true })
    .limit(20);

  if (error) {
    throw new Error(`Failed to fetch conversation history: ${error.message}`);
  }

  return (data ?? []).map((msg: Pick<DBMessage, "role" | "content">) => ({
    role: msg.role as ConversationMessage["role"],
    content: msg.content,
  }));
}

/**
 * Fetch messages from an imported conversation and convert them to
 * ConversationMessage format suitable for prepending to native history.
 */
export async function fetchImportedConversationHistory(
  importedConversationId: string
): Promise<ConversationMessage[]> {
  const messages = await getImportedMessages(importedConversationId);

  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as ConversationMessage["role"],
      content: m.content,
    }));
}

export async function getPreviousModelId(
  conversationId: string
): Promise<string | undefined> {
  const supabase = getSupabase();

  const { data } = await supabase
    .from("messages")
    .select("model_used")
    .eq("conversation_id", conversationId)
    .eq("role", "assistant")
    .order("created_at", { ascending: false })
    .limit(1);

  if (data?.[0]?.model_used) {
    const modelUsed = data[0].model_used as Record<string, unknown>;
    const model = modelUsed.model as Record<string, unknown> | undefined;
    return model?.id as string | undefined;
  }

  return undefined;
}

export function resolveModel(
  adeResponse: ADEResponse,
  selectedModelId?: string
): {
  model: ModelInfo;
  backupModels: ModelInfo[];
  isManualSelection: boolean;
} {
  const toModelInfo = (m: ADEModelResult): ModelInfo => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    score: m.score,
    reasoning: m.reasoning.summary,
  });

  if (selectedModelId) {
    const allModels = [adeResponse.primaryModel, ...adeResponse.backupModels];
    const selected = allModels.find((m) => m.id === selectedModelId);

    if (selected) {
      const others = allModels.filter((m) => m.id !== selectedModelId);
      return {
        model: toModelInfo(selected),
        backupModels: others.map(toModelInfo),
        isManualSelection: true,
      };
    }

    return {
      model: {
        id: selectedModelId,
        name: selectedModelId,
        provider: guessProviderFromModelId(selectedModelId),
        score: 0,
        reasoning: "Manually selected by user",
      },
      backupModels: [adeResponse.primaryModel, ...adeResponse.backupModels].map(toModelInfo),
      isManualSelection: true,
    };
  }

  const primary = adeResponse.primaryModel;
  if (SUPPORTED_PROVIDERS.has(primary.provider)) {
    return {
      model: toModelInfo(primary),
      backupModels: adeResponse.backupModels.map(toModelInfo),
      isManualSelection: false,
    };
  }

  for (const backup of adeResponse.backupModels) {
    if (SUPPORTED_PROVIDERS.has(backup.provider)) {
      const others = adeResponse.backupModels.filter((m) => m.id !== backup.id);
      return {
        model: toModelInfo(backup),
        backupModels: [toModelInfo(primary), ...others.map(toModelInfo)],
        isManualSelection: false,
      };
    }
  }

  throw new Error(
    "No supported provider available. ADE recommended providers that are not yet supported."
  );
}

function guessProviderFromModelId(modelId: string): string {
  if (modelId.startsWith("claude")) return "anthropic";
  if (modelId.startsWith("gpt") || modelId.startsWith("o3") || modelId.startsWith("o4") || modelId.startsWith("dall-e") || modelId.startsWith("gpt-image")) return "openai";
  if (modelId.startsWith("gemini") || modelId.startsWith("imagen")) return "google";
  if (modelId.startsWith("sonar")) return "perplexity";
  if (modelId.startsWith("stable-diffusion")) return "stability";
  return "openai";
}

/** Dedicated image generation models that use separate image APIs (not chat/streaming). */
const DEDICATED_IMAGE_MODELS = new Set([
  "dall-e-3",
  "gpt-image-1",
  "gpt-image-1.5",
  "gpt-image-1-mini",
  "imagen-4",
  "imagen-3",
  "stable-diffusion-3.5",
]);

export function isImageGenerationModel(modelId: string): boolean {
  return DEDICATED_IMAGE_MODELS.has(modelId);
}

/**
 * Chat models that support native image generation via provider-specific tools.
 * OpenAI: image_generation tool in Responses API (GPT-4o, GPT-4.1, GPT-5 series, o3).
 * Google: responseModalities for Gemini image-capable models only.
 * Models NOT in this set should fall back to a dedicated image model.
 */
const NATIVE_IMAGE_GEN_MODELS = new Set([
  // OpenAI — image_generation tool in Responses API
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-5",
  "gpt-5.2",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5-nano",
  "o3",
  // Google — responseModalities (only -image model variants)
  "gemini-2.5-flash-image",
  "gemini-3.1-flash-image-preview",
  "gemini-3-pro-image-preview",
]);

/**
 * Check whether a model can generate images — either as a dedicated image model
 * or as a chat model with verified native image generation support.
 */
export function canModelGenerateImages(modelId: string): boolean {
  return DEDICATED_IMAGE_MODELS.has(modelId) || NATIVE_IMAGE_GEN_MODELS.has(modelId);
}

/**
 * Returns a list of image-capable models we support, grouped by type,
 * for use in user-facing fallback messages.
 */
export function getImageCapableModels(): {
  dedicated: Array<{ id: string; name: string; provider: string }>;
  nativeChat: Array<{ id: string; name: string; provider: string }>;
} {
  return {
    dedicated: [
      { id: "gpt-image-1.5", name: "GPT Image 1.5", provider: "OpenAI" },
      { id: "gpt-image-1-mini", name: "GPT Image 1 Mini", provider: "OpenAI" },
      { id: "dall-e-3", name: "DALL-E 3", provider: "OpenAI" },
      { id: "imagen-4", name: "Imagen 4", provider: "Google" },
      { id: "stable-diffusion-3.5", name: "Stable Diffusion 3.5", provider: "Stability AI" },
    ],
    nativeChat: [
      { id: "gpt-5.4", name: "GPT-5.4", provider: "OpenAI" },
      { id: "gpt-4o", name: "GPT-4o", provider: "OpenAI" },
      { id: "gpt-4.1", name: "GPT-4.1", provider: "OpenAI" },
      { id: "gemini-2.5-flash-image", name: "Gemini 2.5 Flash Image", provider: "Google" },
    ],
  };
}

export function buildSystemPrompt(projectInstructions?: string, options?: { includeFileInstructions?: boolean }): string {
  const basePrompt = [
    "You are a helpful AI assistant powered by Araviel, an intelligent AI platform.",
    "Provide clear, accurate, and well-structured responses.",
    "Do not use emojis in your responses. Keep your tone professional and clean.",
    "Be concise but thorough. If you are unsure about something, say so.",
  ].join(" ");

  let prompt = `${basePrompt}\n\n${getFormattingInstructions()}\n\n${getChartInstructions()}`;

  prompt += `\n\n${getRichBlockInstructions()}`;

  if (options?.includeFileInstructions) {
    prompt += `\n\n${getFileBlockInstructions()}`;
  }

  prompt += `\n\n${getFollowUpInstructions()}`;

  if (projectInstructions && projectInstructions.trim()) {
    prompt += `\n\n--- Project Instructions ---\nThe following instructions were set by the user for this project. Follow them for all responses in this conversation:\n\n${projectInstructions}`;
  }

  return prompt;
}

function getFormattingInstructions(): string {
  return `## Response Formatting

You MUST use rich markdown formatting in every response. Plain-text walls are not acceptable. Follow these rules:

### Structure
- Use **headings** (##, ###) to organize sections in any response longer than 2 paragraphs.
- Use **bold** for key terms, names, and important concepts on first mention.
- Use *italics* for emphasis, definitions, and nuance.
- Use \`inline code\` for function names, file paths, commands, variable names, and technical identifiers.

### Lists
- Use **numbered lists** (1. 2. 3.) for sequential steps, ranked items, or processes with a natural order.
- Use **bullet lists** (- item) for non-sequential collections, features, pros/cons, or options.
- Use **nested lists** when sub-points clarify a parent item.
- NEVER present more than 3 related items as a comma-separated sentence — use a list instead.

### Tables
- Use **markdown tables** when comparing 2+ items across 2+ attributes.
- Always include a header row and alignment.
- Prefer tables over side-by-side descriptions for structured comparisons.

### Code
- Use fenced code blocks (\`\`\`language) for any code, commands, configs, or structured output.
- Always specify the language tag for syntax highlighting.
- Keep code blocks focused — one concept per block.

### Blockquotes
- Use **blockquotes** (> ) for important notes, warnings, caveats, or callouts.
- Start with a bold label: > **Note:** or > **Warning:**

### General
- Break long responses into clear sections with headings.
- Lead with a concise summary or direct answer before elaborating.
- Use horizontal rules (---) to separate major topic shifts within a single response.
- Every response should be scannable — a reader should understand the structure at a glance.`;
}

function getRichBlockInstructions(): string {
  return `## Rich Content Blocks

In addition to standard markdown, you can emit special fenced code blocks that render as interactive visual components. Use these when they genuinely improve comprehension — do NOT overuse them.

### Timeline Block
Use \`\`\`timeline for chronological events, historical progressions, project milestones, or any sequence of dated/ordered events.

Format: JSON array of objects with "date" (or "label") and "title" fields. Optional "description" field for details.

Example:
\`\`\`timeline
[
  {"date": "2020", "title": "Project Founded", "description": "Initial team of 3 engineers started development"},
  {"date": "2021 Q2", "title": "Beta Launch", "description": "Opened to 500 beta users"},
  {"date": "2022", "title": "General Availability", "description": "Public launch with 10k users on day one"},
  {"date": "2023", "title": "Series B", "description": "Raised $50M at $400M valuation"}
]
\`\`\`

Rules:
- Use when showing 3–12 chronological or sequential events.
- "date" or "label" is required as the timeline marker (short, under 20 characters).
- "title" is the event heading (under 60 characters).
- "description" is optional additional context (under 150 characters).
- Order items chronologically.

### Comparison Block
Use \`\`\`comparison for side-by-side feature comparisons, pros/cons, tool evaluations, or option analysis.

Format: JSON object with "items" array. Each item has "name", and any combination of "pros", "cons", "features" (arrays of strings), or "description" (string).

Example:
\`\`\`comparison
{
  "items": [
    {
      "name": "React",
      "description": "Component-based UI library by Meta",
      "pros": ["Huge ecosystem", "Strong job market", "Flexible architecture"],
      "cons": ["Boilerplate heavy", "No built-in routing", "JSX learning curve"]
    },
    {
      "name": "Vue",
      "description": "Progressive framework with gentle learning curve",
      "pros": ["Easy to learn", "Great docs", "Built-in state management"],
      "cons": ["Smaller ecosystem", "Fewer jobs", "Less enterprise adoption"]
    }
  ]
}
\`\`\`

Rules:
- Use for 2–4 items being compared.
- Each item must have a "name".
- Include at least "pros"/"cons" OR "features" for each item.
- Keep each pro/con/feature string under 50 characters.
- "description" is optional (under 100 characters).

### Steps Block
Use \`\`\`steps for how-to guides, setup instructions, tutorials, recipes, or any multi-step process.

Format: JSON array of objects with "title" and "description" fields. Optional "code" field for a command or snippet.

Example:
\`\`\`steps
[
  {"title": "Install dependencies", "description": "Add the required packages to your project", "code": "npm install express cors helmet"},
  {"title": "Create server file", "description": "Set up the entry point with basic middleware configuration"},
  {"title": "Add routes", "description": "Define your API endpoints in a separate routes directory"},
  {"title": "Start the server", "description": "Run in development mode with hot reload", "code": "npm run dev"}
]
\`\`\`

Rules:
- Use when there are 3–10 sequential steps to follow.
- Each step must have "title" (under 60 characters) and "description" (under 200 characters).
- "code" is optional — include only when a specific command or snippet is needed for that step.
- Steps are automatically numbered in the UI.

### When to use rich blocks vs standard markdown
- Use \`\`\`timeline instead of a numbered list when items are date-labeled events.
- Use \`\`\`comparison instead of a table when comparing items with pros/cons or detailed attributes.
- Use \`\`\`steps instead of a numbered list when giving procedural instructions with explanations per step.
- For simple lists (under 5 items, no extra detail needed), prefer standard markdown lists.
- Always place rich blocks AFTER your text analysis, not as a replacement for it.`;
}

function getFileBlockInstructions(): string {
  return `## File Downloads

When the user asks you to generate a downloadable file (e.g., "give me this as a PDF", "export to Excel", "create a Word document", "download as CSV"), you MUST emit a \`\`\`file code block containing a JSON specification. The frontend will generate the actual file client-side and display a download card.

IMPORTANT: Only emit a \`\`\`file block when the user explicitly requests a file download or export. Do NOT proactively generate files.

### Supported Formats
pdf, docx, xlsx, pptx, csv, txt, json, html, md, xml, sql, yaml

### JSON Spec Format

Every file block MUST contain valid JSON with these fields:
- "filename" (required): Full filename with extension (e.g., "report.pdf", "data.xlsx")
- "format" (required): One of the supported format strings above
- "title" (optional): Human-readable title for the document
- "subtitle" (optional): Secondary description
- "content" (required): Format-specific content structure (see below)

### Document Formats (PDF, DOCX, TXT, HTML, MD)

Use a "sections" array for structured documents:

\`\`\`file
{
  "filename": "market-analysis.pdf",
  "format": "pdf",
  "title": "Q4 Market Analysis Report",
  "subtitle": "Prepared by Araviel AI",
  "content": {
    "sections": [
      {"type": "heading", "text": "Executive Summary", "level": 1},
      {"type": "paragraph", "text": "This report provides a comprehensive analysis of Q4 market trends..."},
      {"type": "heading", "text": "Key Metrics", "level": 2},
      {"type": "table", "headers": ["Metric", "Q3", "Q4", "Change"], "rows": [["Revenue", "$1.2M", "$1.5M", "+25%"], ["Users", "5,000", "8,200", "+64%"]]},
      {"type": "heading", "text": "Recommendations", "level": 2},
      {"type": "list", "items": ["Expand into emerging markets", "Increase marketing spend by 15%", "Launch mobile app by Q2"], "ordered": true},
      {"type": "code", "text": "SELECT SUM(revenue) FROM sales WHERE quarter = 'Q4'", "language": "sql"},
      {"type": "divider"},
      {"type": "paragraph", "text": "For questions, contact the analytics team."}
    ]
  }
}
\`\`\`

Section types: "heading" (with level 1-3), "paragraph", "table" (with headers + rows), "list" (with items + ordered boolean), "code" (with text + optional language), "divider".

### Spreadsheet Formats (XLSX, CSV)

Use "sheets" array (XLSX can have multiple sheets; CSV uses first sheet only):

\`\`\`file
{
  "filename": "sales-data.xlsx",
  "format": "xlsx",
  "title": "Sales Report",
  "content": {
    "sheets": [
      {
        "name": "Revenue",
        "headers": ["Month", "Product", "Revenue", "Units Sold"],
        "rows": [
          ["January", "Widget A", 45000, 1200],
          ["January", "Widget B", 32000, 800],
          ["February", "Widget A", 52000, 1400]
        ]
      },
      {
        "name": "Summary",
        "headers": ["Quarter", "Total Revenue", "Growth"],
        "rows": [["Q1", 250000, "12%"], ["Q2", 310000, "24%"]]
      }
    ]
  }
}
\`\`\`

### Presentation Format (PPTX)

Use "slides" array:

\`\`\`file
{
  "filename": "project-update.pptx",
  "format": "pptx",
  "title": "Project Status Update",
  "content": {
    "slides": [
      {"title": "Project Alpha - Status Update", "content": "Q4 2024 Review"},
      {"title": "Key Achievements", "content": ["Launched v2.0 to production", "Onboarded 500 new enterprise users", "Reduced infrastructure costs by 30%"]},
      {"title": "Financial Overview", "table": {"headers": ["Metric", "Target", "Actual"], "rows": [["Revenue", "$2M", "$2.3M"], ["Costs", "$800K", "$720K"]]}},
      {"title": "Next Steps", "content": ["Hire 3 additional engineers", "Launch mobile app beta", "Expand to EU market"], "notes": "Discuss timeline with stakeholders"}
    ]
  }
}
\`\`\`

Slide content can be: a string (displayed as body text), an array of strings (rendered as bullet points), or omitted if a table is provided. Optional "notes" field adds speaker notes. Optional "table" with headers + rows renders a table on the slide.

### Code/Data Formats (JSON, XML, SQL, YAML)

Use raw string content:

\`\`\`file
{
  "filename": "schema.sql",
  "format": "sql",
  "content": "CREATE TABLE users (\\n  id SERIAL PRIMARY KEY,\\n  email VARCHAR(255) UNIQUE NOT NULL,\\n  created_at TIMESTAMP DEFAULT NOW()\\n);"
}
\`\`\`

For JSON format, "content" can be an object/array and will be pretty-printed:

\`\`\`file
{
  "filename": "config.json",
  "format": "json",
  "content": {"data": [{"id": 1, "name": "Example"}]}
}
\`\`\`

### Rules
1. ONLY generate a file block when the user explicitly requests a downloadable file or export.
2. Always provide your normal text response BEFORE the file block — explain what the file contains.
3. The filename must have the correct extension matching the format.
4. For document formats (pdf, docx), use the sections structure for rich formatting — do NOT pass raw text when sections would be more appropriate.
5. For spreadsheets, always include headers.
6. Keep data realistic and consistent with your response text.
7. You can include multiple file blocks in one response if the user asks for multiple formats.
8. Common triggers: "download as...", "export to...", "give me a PDF of...", "create a spreadsheet with...", "save this as...", "generate a file...", "I need a Word doc...".
9. If the user asks for a format not in the supported list, use the closest match (e.g., .doc → docx, .xls → xlsx) and mention it.`;
}

function getFollowUpInstructions(): string {
  return `--- Follow-Up & Questions ---
At the very end of EVERY response, you MUST append a metadata block. This block will be parsed and stripped — the user will never see it. It must be the absolute last thing in your response.

Format:
<araviel_meta>
{"followUps":["suggestion 1","suggestion 2","suggestion 3"],"questions":[]}
</araviel_meta>

CRITICAL RULES:
1. "followUps" — ALWAYS provide exactly 3 short, contextual follow-up suggestions. Each must be a concise prompt (under 60 characters) that naturally continues the conversation. They should be relevant to both the user's question and your response. Never generic filler.
2. "questions" — ONLY include when you genuinely need clarification or preferences from the user before giving a better answer. When included, each question object has:
   - "question": a short, clear question (under 80 characters)
   - "options": exactly 3 short option strings (under 40 characters each) representing the most likely answers
3. If you do not need to ask questions, set "questions" to an empty array [].
4. The entire block must be valid JSON inside the <araviel_meta> tags.
5. Do NOT reference this metadata block in your visible response.
6. Follow-ups should feel like natural next steps, not repetitions of what was already said.
7. IMPORTANT — When you have questions or choices for the user (e.g. "Would you like me to...", "Do you prefer...", "Which option..."), you MUST:
   - Put them ONLY in the "questions" array inside the metadata block.
   - Do NOT write the questions, choices, options, or bullet-point lists of choices in your visible response text.
   - Your visible response should end BEFORE any questions. Just provide your answer/analysis, then put questions exclusively in the metadata.
   - For example, instead of writing "Would you like me to: (a) do X, (b) do Y, (c) do Z?" in the response, just end the response after your analysis and put {"question":"What would you like next?","options":["Do X","Do Y","Do Z"]} in the questions array.

Example with questions (note: the visible response does NOT contain the questions):
<araviel_meta>
{"followUps":["Compare with alternatives","Show a practical example","Explain the trade-offs"],"questions":[{"question":"What's your experience level?","options":["Beginner","Intermediate","Advanced"]},{"question":"Which language do you prefer?","options":["Python","JavaScript","TypeScript"]}]}
</araviel_meta>

Example without questions:
<araviel_meta>
{"followUps":["Dive deeper into performance","See real-world use cases","Explore related patterns"],"questions":[]}
</araviel_meta>`;
}

export async function getProjectInstructionsForConversation(
  conversationId: string
): Promise<string | null> {
  const supabase = getSupabase();

  const { data: conversation, error: convError } = await supabase
    .from("conversations")
    .select("project_id")
    .eq("id", conversationId)
    .single();

  if (convError || !conversation?.project_id) {
    return null;
  }

  const { data: project, error: projError } = await supabase
    .from("projects")
    .select("instructions")
    .eq("id", conversation.project_id)
    .single();

  if (projError || !project?.instructions) {
    return null;
  }

  return project.instructions;
}

export function resolveWebSearch(
  userWebSearch: boolean | undefined,
  analysis: ADEResponse["analysis"]
): { shouldUseWebSearch: boolean; webSearchAutoDetected: boolean } {
  // User explicitly toggled web search on
  if (userWebSearch === true) {
    return { shouldUseWebSearch: true, webSearchAutoDetected: false };
  }

  // User explicitly toggled web search off
  if (userWebSearch === false) {
    return { shouldUseWebSearch: false, webSearchAutoDetected: false };
  }

  // Auto mode: check ADE's webSearchRequired, fall back to intent-based detection
  const adeRecommends = analysis.webSearchRequired ?? detectWebSearchFromIntent(analysis);
  return { shouldUseWebSearch: adeRecommends, webSearchAutoDetected: adeRecommends };
}

function detectWebSearchFromIntent(analysis: ADEResponse["analysis"]): boolean {
  const searchIntents = new Set([
    "research",
    "current_events",
    "news",
    "factual_lookup",
    "fact_checking",
    "information_retrieval",
  ]);
  return searchIntents.has(analysis.intent);
}

export function shouldEnableThinking(analysis: ADEResponse["analysis"]): boolean {
  return analysis.complexity === "demanding";
}

/** Fast keyword check to detect if user is requesting a file download/export. */
const FILE_INTENT_PATTERNS = /\b(download\s+as|export\s+(?:to|as|it)|save\s+(?:as|to|this)|give\s+me\s+(?:a|the)\s+(?:pdf|docx?|xlsx?|csv|pptx?|word|excel|powerpoint|spreadsheet|presentation|text\s+file)|create\s+(?:a|the)\s+(?:pdf|docx?|xlsx?|csv|pptx?|word|excel|powerpoint|spreadsheet|presentation)|generate\s+(?:a|the)\s+(?:file|pdf|docx?|xlsx?|csv|pptx?|word|excel|powerpoint|spreadsheet|presentation)|as\s+(?:a\s+)?(?:pdf|docx?|xlsx?|csv|pptx?)\b|\.pdf\b|\.docx?\b|\.xlsx?\b|\.csv\b|\.pptx?\b|i\s+need\s+(?:a|the)\s+(?:pdf|word|excel|spreadsheet|powerpoint|presentation|file)|convert\s+(?:to|this|it)\s+(?:to\s+)?(?:pdf|word|excel|csv|powerpoint)|make\s+(?:a|me\s+a)\s+(?:pdf|word|excel|spreadsheet|csv|powerpoint|presentation))\b/i;

export function detectFileIntent(message: string): boolean {
  return FILE_INTENT_PATTERNS.test(message);
}

export function findSupportedBackup(
  backupModels: ModelInfo[]
): ModelInfo | undefined {
  return backupModels.find((m) => SUPPORTED_PROVIDERS.has(m.provider));
}

export async function createSubConversation(
  conversationId: string,
  parentMessageId: string,
  highlightedText: string
): Promise<DBSubConversation> {
  const supabase = getSupabase();
  const id = randomUUID();
  const now = new Date().toISOString();

  // Verify parent message exists and belongs to the conversation
  const { data: msg, error: msgError } = await supabase
    .from("messages")
    .select("id")
    .eq("id", parentMessageId)
    .eq("conversation_id", conversationId)
    .single();

  if (msgError || !msg) {
    throw new Error("Parent message not found in this conversation");
  }

  const { error } = await supabase.from("sub_conversations").insert({
    id,
    conversation_id: conversationId,
    parent_message_id: parentMessageId,
    highlighted_text: highlightedText,
    created_at: now,
    updated_at: now,
  });

  if (error) {
    throw new Error(`Failed to create sub-conversation: ${error.message}`);
  }

  return {
    id,
    conversation_id: conversationId,
    parent_message_id: parentMessageId,
    highlighted_text: highlightedText,
    is_starred: false,
    is_archived: false,
    is_reported: false,
    created_at: now,
    updated_at: now,
  };
}

export async function getSubConversations(
  parentMessageId: string
): Promise<DBSubConversation[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("sub_conversations")
    .select("*")
    .eq("parent_message_id", parentMessageId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to fetch sub-conversations: ${error.message}`);
  }

  return (data ?? []) as DBSubConversation[];
}

export async function validateSubConversation(
  subConversationId: string
): Promise<{ conversationId: string }> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("sub_conversations")
    .select("conversation_id")
    .eq("id", subConversationId)
    .single();

  if (error || !data) {
    throw new Error(`Sub-conversation not found: ${subConversationId}`);
  }

  return { conversationId: data.conversation_id };
}

export { randomUUID };

export type { DBConversation, DBMessage, DBSubConversation };
