import { NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { encrypt, decrypt } from "@/lib/encryption";

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

// Default user ID used until real authentication is implemented.
// All existing routes in the codebase operate without auth; this matches
// that pattern while keeping user_id scoping in place for a smooth
// migration to real auth later.
const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Extract user ID from request. Uses x-user-id header if present,
 * otherwise falls back to a default placeholder.
 * Replace this with real auth (JWT / Supabase Auth) when ready.
 */
export function getUserId(request: NextRequest): string {
  return request.headers.get("x-user-id") || DEFAULT_USER_ID;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImportedMessage {
  id: string;
  role: string;
  content: string;
  createdAt: string;
}

export interface ImportConversationInput {
  externalId?: string | null;
  title: string;
  provider: string;
  providerName: string;
  messages: ImportedMessage[];
  messageCount: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface ImportedConversationRow {
  id: string;
  user_id: string;
  provider: string;
  provider_name: string;
  external_id: string | null;
  title: string;
  message_count: number;
  is_starred: boolean;
  is_archived: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ImportedConversationResponse {
  id: string;
  externalId: string | null;
  title: string;
  provider: string;
  providerName: string;
  messageCount: number;
  isStarred: boolean;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

export function toResponse(row: ImportedConversationRow): ImportedConversationResponse {
  return {
    id: row.id,
    externalId: row.external_id,
    title: row.title,
    provider: row.provider,
    providerName: row.provider_name,
    messageCount: row.message_count,
    isStarred: row.is_starred,
    isArchived: row.is_archived,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateConversationInput(
  conv: unknown,
  index: number
): string | null {
  const c = conv as Record<string, unknown>;

  if (!c.provider || typeof c.provider !== "string" || !c.provider.trim()) {
    return `conversations[${index}].provider must be a non-empty string`;
  }
  if (!c.providerName || typeof c.providerName !== "string" || !c.providerName.trim()) {
    return `conversations[${index}].providerName must be a non-empty string`;
  }
  if (!c.title || typeof c.title !== "string" || !c.title.trim()) {
    return `conversations[${index}].title must be a non-empty string`;
  }
  if (!Array.isArray(c.messages) || c.messages.length === 0) {
    return `conversations[${index}].messages must be a non-empty array`;
  }
  if (
    typeof c.messageCount !== "number" ||
    !Number.isInteger(c.messageCount) ||
    c.messageCount < 1
  ) {
    return `conversations[${index}].messageCount must be a positive integer`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

const CONVERSATION_COLUMNS =
  "id, user_id, provider, provider_name, external_id, title, message_count, is_starred, is_archived, deleted_at, created_at, updated_at";

/**
 * Bulk import conversations with encrypted messages.
 * Uses a Supabase RPC-based transaction via individual inserts wrapped in
 * application-level logic. Duplicates (by user_id+provider+external_id) are
 * skipped gracefully.
 */
export async function bulkImport(
  userId: string,
  conversations: ImportConversationInput[]
): Promise<{
  imported: number;
  skipped: number;
  conversations: ImportedConversationResponse[];
}> {
  const supabase = getSupabase();

  // Pre-check for existing external_ids to determine which to skip
  const externalIds = conversations
    .map((c) => c.externalId)
    .filter((eid): eid is string => eid != null && eid !== "");

  const existingSet = new Set<string>();

  if (externalIds.length > 0) {
    const { data: existing } = await supabase
      .from("imported_conversations")
      .select("provider, external_id")
      .eq("user_id", userId)
      .not("external_id", "is", null)
      .in("external_id", externalIds);

    if (existing) {
      for (const row of existing) {
        existingSet.add(`${row.provider}::${row.external_id}`);
      }
    }
  }

  const toInsert: {
    conv: ImportConversationInput;
    convRow: Record<string, unknown>;
    msgRow: Record<string, unknown>;
  }[] = [];
  let skipped = 0;

  for (const conv of conversations) {
    // Check duplicate
    if (
      conv.externalId &&
      existingSet.has(`${conv.provider}::${conv.externalId}`)
    ) {
      skipped++;
      continue;
    }

    const now = new Date().toISOString();
    const convId = crypto.randomUUID();

    const convRow = {
      id: convId,
      user_id: userId,
      provider: conv.provider.trim(),
      provider_name: conv.providerName.trim(),
      external_id: conv.externalId?.trim() || null,
      title: conv.title.trim(),
      message_count: conv.messageCount,
      is_starred: false,
      is_archived: false,
      created_at: conv.createdAt || now,
      updated_at: conv.updatedAt || now,
    };

    const encryptedMessages = encrypt(JSON.stringify(conv.messages));

    const msgRow = {
      conversation_id: convId,
      user_id: userId,
      messages_encrypted: encryptedMessages,
    };

    toInsert.push({ conv, convRow, msgRow });
  }

  if (toInsert.length === 0) {
    return { imported: 0, skipped, conversations: [] };
  }

  // Batch insert conversations
  const { data: insertedConvs, error: convError } = await supabase
    .from("imported_conversations")
    .insert(toInsert.map((t) => t.convRow))
    .select(CONVERSATION_COLUMNS);

  if (convError) {
    throw new Error(`Failed to import conversations: ${convError.message}`);
  }

  // Batch insert encrypted messages
  const { error: msgError } = await supabase
    .from("imported_conversation_messages")
    .insert(toInsert.map((t) => t.msgRow));

  if (msgError) {
    // Attempt to rollback conversation inserts
    const ids = toInsert.map((t) => t.convRow.id as string);
    await supabase
      .from("imported_conversations")
      .delete()
      .in("id", ids);
    throw new Error(`Failed to import messages: ${msgError.message}`);
  }

  return {
    imported: insertedConvs?.length ?? toInsert.length,
    skipped,
    conversations: (insertedConvs ?? []).map((r: Record<string, unknown>) =>
      toResponse(r as unknown as ImportedConversationRow)
    ),
  };
}

/**
 * List imported conversations for a user with optional filters.
 */
export async function listConversations(
  userId: string,
  filters: {
    provider?: string;
    archived?: boolean;
    starred?: boolean;
  }
): Promise<ImportedConversationResponse[]> {
  const supabase = getSupabase();
  const { archived = false, provider, starred } = filters;

  let query = supabase
    .from("imported_conversations")
    .select(CONVERSATION_COLUMNS)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .eq("is_archived", archived)
    .order("created_at", { ascending: false });

  if (provider) {
    query = query.eq("provider", provider);
  }
  if (starred !== undefined) {
    query = query.eq("is_starred", starred);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to list conversations: ${error.message}`);
  }

  return (data ?? []).map((r: Record<string, unknown>) =>
    toResponse(r as unknown as ImportedConversationRow)
  );
}

/**
 * Get decrypted messages for a single imported conversation.
 */
export async function getMessages(
  userId: string,
  conversationId: string
): Promise<ImportedMessage[]> {
  const supabase = getSupabase();

  // Verify ownership and not soft-deleted
  const { data: conv, error: convError } = await supabase
    .from("imported_conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .single();

  if (convError || !conv) {
    const err = new Error("Conversation not found");
    (err as Error & { statusCode: number }).statusCode = 404;
    throw err;
  }

  const { data: msgRow, error: msgError } = await supabase
    .from("imported_conversation_messages")
    .select("messages_encrypted")
    .eq("conversation_id", conversationId)
    .eq("user_id", userId)
    .single();

  if (msgError || !msgRow) {
    const err = new Error("Messages not found");
    (err as Error & { statusCode: number }).statusCode = 404;
    throw err;
  }

  const decrypted = decrypt(msgRow.messages_encrypted);
  return JSON.parse(decrypted) as ImportedMessage[];
}

/**
 * Update metadata on a single imported conversation.
 */
export async function updateConversation(
  userId: string,
  conversationId: string,
  updates: { title?: string; isStarred?: boolean; isArchived?: boolean }
): Promise<ImportedConversationResponse> {
  const supabase = getSupabase();

  const updatePayload: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (updates.title !== undefined) {
    if (typeof updates.title !== "string" || !updates.title.trim()) {
      throw new Error("title must be a non-empty string");
    }
    updatePayload.title = updates.title.trim();
  }
  if (updates.isStarred !== undefined) {
    updatePayload.is_starred = updates.isStarred;
  }
  if (updates.isArchived !== undefined) {
    updatePayload.is_archived = updates.isArchived;
  }

  const { data, error } = await supabase
    .from("imported_conversations")
    .update(updatePayload)
    .eq("id", conversationId)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .select(CONVERSATION_COLUMNS)
    .single();

  if (error || !data) {
    const err = new Error("Conversation not found");
    (err as Error & { statusCode: number }).statusCode = 404;
    throw err;
  }

  return toResponse(data as ImportedConversationRow);
}

/**
 * Bulk update metadata on multiple imported conversations.
 */
export async function bulkUpdate(
  userId: string,
  ids: string[],
  updates: { isStarred?: boolean; isArchived?: boolean }
): Promise<number> {
  const supabase = getSupabase();

  const updatePayload: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (updates.isStarred !== undefined) {
    updatePayload.is_starred = updates.isStarred;
  }
  if (updates.isArchived !== undefined) {
    updatePayload.is_archived = updates.isArchived;
  }

  const { data, error } = await supabase
    .from("imported_conversations")
    .update(updatePayload)
    .in("id", ids)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .select("id");

  if (error) {
    throw new Error(`Failed to bulk update: ${error.message}`);
  }

  return data?.length ?? 0;
}

/**
 * Soft-delete a single imported conversation.
 */
export async function softDelete(
  userId: string,
  conversationId: string
): Promise<void> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("imported_conversations")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", conversationId)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .select("id")
    .single();

  if (error || !data) {
    const err = new Error("Conversation not found");
    (err as Error & { statusCode: number }).statusCode = 404;
    throw err;
  }
}

/**
 * Bulk soft-delete imported conversations.
 */
export async function bulkSoftDelete(
  userId: string,
  ids: string[]
): Promise<number> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("imported_conversations")
    .update({ deleted_at: new Date().toISOString() })
    .in("id", ids)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .select("id");

  if (error) {
    throw new Error(`Failed to bulk delete: ${error.message}`);
  }

  return data?.length ?? 0;
}
