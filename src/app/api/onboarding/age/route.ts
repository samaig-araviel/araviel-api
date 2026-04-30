import { NextRequest } from "next/server";
import { withAuth } from "@/lib/auth";
import type { AuthenticatedUser } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { handleCorsOptions } from "../../cors";
import { requestContext } from "@/lib/request-context";
import {
  badRequest,
  conflict,
  respondError,
  respondJson,
} from "@/lib/error-response";
import {
  deriveStatus,
  formatIsoDate,
  getAgeVerificationConfig,
  parseIsoDate,
  type AgeStatus,
} from "@/lib/age";

export const runtime = "nodejs";

interface AgePayload {
  ageVerification: {
    enabled: boolean;
    status: AgeStatus;
    minimumAge: number;
    dateOfBirth: string | null;
  };
}

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

/**
 * POST /api/onboarding/age
 *
 * Records the user's date of birth and returns the derived verification
 * status. DOB is write-once: once a non-null value exists the endpoint
 * returns 409 so a blocked user cannot retry with a different date. The
 * settings PUT endpoint excludes `date_of_birth` from its allowed columns,
 * so this is the only path that can set it.
 *
 * If the feature flag is off, the call is a no-op that returns
 * `status: 'verified'` — keeps the client contract uniform across deploys.
 */
export const POST = withAuth(async (request: NextRequest, user: AuthenticatedUser) => {
  const origin = request.headers.get("origin");
  const ctx = requestContext(request, "onboarding.age.submit");

  try {
    const config = getAgeVerificationConfig();

    if (!config.enabled) {
      return respondJson<AgePayload>(
        {
          ageVerification: {
            enabled: false,
            status: "verified",
            minimumAge: config.minimumAge,
            dateOfBirth: null,
          },
        },
        { requestId: ctx.requestId, origin },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw badRequest(
        "Request body must be valid JSON",
        "Something went wrong submitting your date of birth. Please try again.",
      );
    }

    const dobInput = (body as { dateOfBirth?: unknown })?.dateOfBirth;
    const dob = parseIsoDate(dobInput);

    const supabase = getSupabase();

    const existing = await supabase
      .from("user_settings")
      .select("date_of_birth")
      .eq("user_id", user.id)
      .maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data?.date_of_birth) {
      throw conflict(
        "Date of birth is already set for this user",
        "Your date of birth has already been recorded.",
      );
    }

    const dobIso = formatIsoDate(dob);
    const upsert = await supabase
      .from("user_settings")
      .upsert(
        { user_id: user.id, date_of_birth: dobIso },
        { onConflict: "user_id" },
      )
      .select("date_of_birth")
      .single();
    if (upsert.error) throw upsert.error;

    const status = deriveStatus(dob, config.minimumAge);

    return respondJson<AgePayload>(
      {
        ageVerification: {
          enabled: true,
          status,
          minimumAge: config.minimumAge,
          dateOfBirth: dobIso,
        },
      },
      { requestId: ctx.requestId, origin },
    );
  } catch (err) {
    return respondError(err, ctx.log, { requestId: ctx.requestId, origin });
  }
});
