import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { authenticateRequest, AuthError } from "@/lib/auth";
import type { AuthenticatedUser } from "@/lib/auth";
import { corsHeaders, handleCorsOptions } from "../cors";

const DEFAULT_SETTINGS = {
  display_name: "User",
  bio: "",
  preferred_language: "English",
  response_tone: "default",
  custom_instructions: "",
  occupation: "",
  expertise: "",
  answer_font: "system",
  send_with_enter: true,
  default_model: "auto",
  enable_reasoning: true,
  web_search_default: "auto",
  image_quality_default: "standard",
  enable_follow_ups: true,
  save_history: true,
  enable_analytics: true,
  ai_data_retention: false,
  location_metadata: false,
  notify_new_features: true,
  notify_usage_limits: true,
  usage_limit_thresholds: [20, 10, 5],
  avatar_url: "",
  full_name: "",
  phone: "",
  website: "",
  location: "",
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
  answerFont: "answer_font",
  sendWithEnter: "send_with_enter",
  defaultModel: "default_model",
  enableReasoning: "enable_reasoning",
  webSearchDefault: "web_search_default",
  imageQualityDefault: "image_quality_default",
  enableFollowUps: "enable_follow_ups",
  saveHistory: "save_history",
  enableAnalytics: "enable_analytics",
  aiDataRetention: "ai_data_retention",
  locationMetadata: "location_metadata",
  notifyNewFeatures: "notify_new_features",
  notifyUsageLimits: "notify_usage_limits",
  usageLimitThresholds: "usage_limit_thresholds",
  avatarUrl: "avatar_url",
  fullName: "full_name",
  phone: "phone",
  website: "website",
  location: "location",
};

// Whitelist of settings the API will accept. Anything outside this set is
// dropped on write so old clients sending retired columns (font_size,
// compact_mode, show_code_line_numbers, show_model_info, notify_sounds)
// can't poison the row.
const ALLOWED_COLUMNS = new Set(Object.values(CAMEL_TO_SNAKE));

function toSnakeCase(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = CAMEL_TO_SNAKE[key] ?? key;
    if (!ALLOWED_COLUMNS.has(snakeKey)) continue;
    result[snakeKey] = value;
  }
  return result;
}

export async function OPTIONS() {
  return handleCorsOptions();
}

/**
 * GET /api/settings
 * Returns the user's settings, falling back to defaults if none exist.
 */
export async function GET(request: NextRequest) {
  let user: AuthenticatedUser;
  try {
    user = await authenticateRequest(request);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status, headers: corsHeaders() });
    }
    throw err;
  }

  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("user_settings")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 500, headers: corsHeaders() }
      );
    }

    const settings = data
      ? { ...DEFAULT_SETTINGS, ...data }
      : { ...DEFAULT_SETTINGS, user_id: user.id };

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
 * Body: { settings: { ...partial settings } }
 * Upserts the user's settings.
 */
export async function PUT(request: NextRequest) {
  let user: AuthenticatedUser;
  try {
    user = await authenticateRequest(request);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status, headers: corsHeaders() });
    }
    throw err;
  }

  try {
    const body = await request.json();
    const { settings } = body;

    if (!settings) {
      return NextResponse.json(
        { error: "settings are required" },
        { status: 400, headers: corsHeaders() }
      );
    }

    const snakeSettings = toSnakeCase(settings);
    const row = { user_id: user.id, ...snakeSettings };

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
