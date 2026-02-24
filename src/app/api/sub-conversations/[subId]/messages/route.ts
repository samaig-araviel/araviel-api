import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import type { DBMessage, Citation, ModelInfo } from "@/lib/types";
import { corsHeaders, handleCorsOptions } from "../../../cors";

interface FormattedMessage {
  id: string;
  conversationId: string;
  subConversationId: string;
  role: string;
  content: string;
  createdAt: string;
  model?: ModelInfo | null;
  alternateModels?: ModelInfo[] | null;
  thinkingContent?: string | null;
  citations?: Citation[] | null;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cachedTokens: number;
  } | null;
  costUsd?: number | null;
  latencyMs?: number | null;
  adeLatencyMs?: number | null;
}

function formatMessage(msg: DBMessage): FormattedMessage {
  const base: FormattedMessage = {
    id: msg.id,
    conversationId: msg.conversation_id,
    subConversationId: msg.sub_conversation_id!,
    role: msg.role,
    content: msg.content,
    createdAt: msg.created_at,
  };

  if (msg.role !== "assistant") {
    return base;
  }

  const modelUsed = msg.model_used as {
    model?: ModelInfo;
    backupModels?: ModelInfo[];
  } | null;

  const extendedData = msg.extended_data as {
    thinkingContent?: string;
    citations?: Citation[];
  } | null;

  return {
    ...base,
    model: modelUsed?.model ?? null,
    alternateModels: modelUsed?.backupModels ?? null,
    thinkingContent: extendedData?.thinkingContent ?? null,
    citations: extendedData?.citations ?? null,
    usage:
      msg.tokens_input !== null
        ? {
            inputTokens: msg.tokens_input ?? 0,
            outputTokens: msg.tokens_output ?? 0,
            reasoningTokens: msg.tokens_reasoning ?? 0,
            cachedTokens: msg.tokens_cached ?? 0,
          }
        : null,
    costUsd: msg.cost_usd,
    latencyMs: msg.latency_ms,
    adeLatencyMs: msg.ade_latency_ms,
  };
}

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subId: string }> }
) {
  try {
    const { subId } = await params;
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get("limit") ?? "50", 10), 200);
    const offset = parseInt(searchParams.get("offset") ?? "0", 10);

    const supabase = getSupabase();

    // Verify sub-conversation exists and get its metadata
    const { data: subConv, error: subConvError } = await supabase
      .from("sub_conversations")
      .select("id, conversation_id, parent_message_id, highlighted_text")
      .eq("id", subId)
      .single();

    if (subConvError || !subConv) {
      return NextResponse.json(
        { error: "Sub-conversation not found" },
        { status: 404, headers: corsHeaders(request.headers.get("origin")) }
      );
    }

    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .eq("sub_conversation_id", subId)
      .order("created_at", { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 500, headers: corsHeaders(request.headers.get("origin")) }
      );
    }

    const messages = ((data as DBMessage[]) ?? []).map(formatMessage);

    return NextResponse.json(
      {
        subConversation: {
          id: subConv.id,
          conversationId: subConv.conversation_id,
          parentMessageId: subConv.parent_message_id,
          highlightedText: subConv.highlighted_text,
        },
        messages,
      },
      { headers: corsHeaders(request.headers.get("origin")) }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500, headers: corsHeaders(request.headers.get("origin")) }
    );
  }
}
