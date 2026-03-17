import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { corsHeaders, handleCorsOptions } from "../cors";

const DEFAULT_SETTINGS = {
  display_name: "User",
  bio: "",
  preferred_language: "English",
  response_tone: "default",
  custom_instructions: "",
  occupation: "",
  expertise: "",
  font_size: "medium",
  answer_font: "sans-serif",
  compact_mode: false,
  send_with_enter: true,
  show_code_line_numbers: true,
  default_model: "auto",
  enable_reasoning: true,
  show_model_info: true,
  web_search_default: "auto",
  image_quality_default: "standard",
  enable_follow_ups: true,
  save_history: true,
  enable_analytics: true,
  ai_data_retention: false,
  location_metadata: false,
  notify_new_features: true,
  notify_usage_limits: true,
  notify_sounds: true,
};

/** Map camelCase frontend keys to snake_case DB columns. */
const CAMEL_TO_SNAKE: Record<string, string> = {
  displayName: "display_name",
  bio: "bio",
  preferredLanguage: "preferred_language",
  responseTone: "response_tone",
  customInstructions: "custom_instructions",
  occupation: "occupation",
  expertise: "expertise",
  fontSize: "font_size",
  answerFont: "answer_font",
  compactMode: "compact_mode",
  sendWithEnter: "send_with_enter",
  showCodeLineNumbers: "show_code_line_numbers",
  defaultModel: "default_model",
  enableReasoning: "enable_reasoning",
  showModelInfo: "show_model_info",
  webSearchDefault: "web_search_default",
  imageQualityDefault: "image_quality_default",
  enableFollowUps: "enable_follow_ups",
  saveHistory: "save_history",
  enableAnalytics: "enable_analytics",
  aiDataRetention: "ai_data_retention",
  locationMetadata: "location_metadata",
  notifyNewFeatures: "notify_new_features",
  notifyUsageLimits: "notify_usage_limits",
  notifySounds: "notify_sounds",
};

function toSnakeCase(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = CAMEL_TO_SNAKE[key] ?? key;
    result[snakeKey] = value;
  }
  return result;
}

export async function OPTIONS() {
  return handleCorsOptions();
}

/**
 * GET /api/settings?userId=...
 * Returns the user's settings, falling back to defaults if none exist.
 */
export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get("userId");
  if (!userId) {
    return NextResponse.json(
      { error: "userId is required" },
      { status: 400, headers: corsHeaders() }
    );
  }

  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("user_settings")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 500, headers: corsHeaders() }
      );
    }

    const settings = data
      ? { ...DEFAULT_SETTINGS, ...data }
      : { ...DEFAULT_SETTINGS, user_id: userId };

    return NextResponse.json({ settings }, { headers: corsHeaders() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to get settings" },
      { status: 500, headers: corsHeaders() }
    );
  }
}

/**
 * PUT /api/settings
 * Body: { userId: string, settings: { ...partial settings } }
 * Upserts the user's settings.
 */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { userId, settings } = body;

    if (!userId || !settings) {
      return NextResponse.json(
        { error: "userId and settings are required" },
        { status: 400, headers: corsHeaders() }
      );
    }

    const snakeSettings = toSnakeCase(settings);
    const row = { user_id: userId, ...snakeSettings };

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("user_settings")
      .upsert(row, { onConflict: "user_id" })
      .select("*")
      .single();

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 500, headers: corsHeaders() }
      );
    }

    return NextResponse.json({ settings: data }, { headers: corsHeaders() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update settings" },
      { status: 500, headers: corsHeaders() }
    );
  }
}
