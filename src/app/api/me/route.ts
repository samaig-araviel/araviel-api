import { NextRequest } from "next/server";
import { withAuth } from "@/lib/auth";
import type { AuthenticatedUser } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { handleCorsOptions } from "../cors";
import { requestContext } from "@/lib/request-context";
import { respondError, respondJson } from "@/lib/error-response";
import {
  deriveStatus,
  formatIsoDate,
  getAgeVerificationConfig,
  type AgeStatus,
} from "@/lib/age";

export const runtime = "nodejs";

/**
 * Canonical "current user" payload. Returned on every sign-in so the web
 * client can decide whether to gate the user behind onboarding. Status is
 * always derived live from the stored DOB, so a user blocked at 12 will
 * progress naturally on the request after their 13th birthday — no
 * server-side bookkeeping required.
 */
interface AgeVerificationPayload {
  enabled: boolean;
  status: AgeStatus;
  minimumAge: number;
  dateOfBirth: string | null;
}

interface MePayload {
  id: string;
  email: string | null;
  isAnonymous: boolean;
  ageVerification: AgeVerificationPayload;
}

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

export const GET = withAuth(async (request: NextRequest, user: AuthenticatedUser) => {
  const origin = request.headers.get("origin");
  const ctx = requestContext(request, "me.get");

  try {
    const config = getAgeVerificationConfig();

    let dateOfBirth: Date | null = null;
    if (config.enabled) {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from("user_settings")
        .select("date_of_birth")
        .eq("user_id", user.id)
        .maybeSingle();
      if (error) throw error;
      const raw = data?.date_of_birth as string | null | undefined;
      // Postgres returns DATE as `YYYY-MM-DD`; treat that as a UTC midnight so
      // age math stays timezone-stable regardless of where the API runs.
      dateOfBirth = raw ? new Date(`${raw}T00:00:00Z`) : null;
    }

    // When the feature is off we always report `verified` so the web gate is
    // a no-op; once the operator flips the flag, every existing session re-
    // resolves to its real status on the next /me call.
    const status: AgeStatus = config.enabled
      ? deriveStatus(dateOfBirth, config.minimumAge)
      : "verified";

    const payload: MePayload = {
      id: user.id,
      email: user.email ?? null,
      isAnonymous: user.isAnonymous,
      ageVerification: {
        enabled: config.enabled,
        status,
        minimumAge: config.minimumAge,
        dateOfBirth: dateOfBirth ? formatIsoDate(dateOfBirth) : null,
      },
    };

    return respondJson(payload, { requestId: ctx.requestId, origin });
  } catch (err) {
    return respondError(err, ctx.log, { requestId: ctx.requestId, origin });
  }
});
