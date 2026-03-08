import type {
  ImportConversationInput,
  ImportedMessage,
} from "./imported-conversations";

// ---------------------------------------------------------------------------
// Claude export types (subset of fields we care about)
// ---------------------------------------------------------------------------

interface ClaudeContentBlock {
  type: string;
  text?: string;
}

interface ClaudeMessage {
  uuid: string;
  sender: string;
  text: string;
  created_at: string;
  content?: ClaudeContentBlock[];
}

interface ClaudeConversation {
  uuid: string;
  name: string;
  created_at: string;
  updated_at: string;
  chat_messages: ClaudeMessage[];
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Returns true if the parsed body looks like a raw Claude conversation export
 * (a bare array where items have `chat_messages`).
 */
export function isClaudeExportFormat(
  body: unknown
): body is ClaudeConversation[] {
  if (!Array.isArray(body) || body.length === 0) return false;
  const first = body[0];
  return first != null && typeof first === "object" && "chat_messages" in first;
}

// ---------------------------------------------------------------------------
// Transformation
// ---------------------------------------------------------------------------

function mapRole(sender: string): string {
  return sender === "human" ? "user" : "assistant";
}

function extractContent(msg: ClaudeMessage): string {
  if (Array.isArray(msg.content)) {
    const textParts = msg.content
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text as string);
    if (textParts.length > 0) return textParts.join("\n");
  }
  return msg.text || "";
}

function transformMessage(msg: ClaudeMessage): ImportedMessage {
  return {
    id: msg.uuid,
    role: mapRole(msg.sender),
    content: extractContent(msg),
    createdAt: msg.created_at,
  };
}

/**
 * Converts a raw Claude conversation export array into the shape the
 * bulk-import endpoint expects. Filters out empty messages.
 */
export function transformClaudeExport(
  raw: ClaudeConversation[]
): { conversations: ImportConversationInput[] } {
  const conversations: ImportConversationInput[] = raw.map((c) => {
    const messages = (c.chat_messages || [])
      .map(transformMessage)
      .filter((m) => m.content.trim().length > 0);

    return {
      externalId: c.uuid || null,
      title: c.name || "Untitled Conversation",
      provider: "claude",
      providerName: "Claude",
      messages,
      messageCount: messages.length,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
    };
  });

  return { conversations };
}
