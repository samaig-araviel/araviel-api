import { NextRequest } from "next/server";
import { withAuth } from "@/lib/auth";
import type { AuthenticatedUser } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { handleCorsOptions } from "../../../cors";
import { requestContext } from "@/lib/request-context";
import {
  badRequest,
  respondError,
  respondJson,
} from "@/lib/error-response";
import {
  deriveStatus,
  formatIsoDate,
  getAgeVerificationConfig,
  type AgeStatus,
} from "@/lib/age";

export const runtime = "nodejs";

const PEOPLE_API_URL =
  "https://people.googleapis.com/v1/people/me?personFields=birthdays";

interface GoogleAgePayload {
  requiresManualEntry: boolean;
  ageVerification: {
    enabled: boolean;
    status: AgeStatus;
    minimumAge: number;
    dateOfBirth: string | null;
  };
}

interface GoogleBirthday {
  date?: { year?: number; month?: number; day?: number };
  metadata?: { primary?: boolean; source?: { type?: string } };
}

interface GooglePeopleResponse {
  birthdays?: GoogleBirthday[];
}

/**
 * Pick the most authoritative birthday from Google's `birthdays[]`. Google
 * returns up to two entries (account + profile); the primary one with all
 * three date components is the only one we trust. Anything missing the year
 * is unusable for an age check.
 */
function pickFullBirthday(
  birthdays: GoogleBirthday[] | undefined,
): { year: number; month: number; day: number } | null {
  if (!birthdays?.length) return null;
  const sorted = [...birthdays].sort((a, b) => {
    const ap = a.metadata?.primary ? 0 : 1;
    const bp = b.metadata?.primary ? 0 : 1;
    return ap - bp;
  });
  for (const entry of sorted) {
    const d = entry.date;
    if (d?.year && d?.month && d?.day) {
      return { year: d.year, month: d.month, day: d.day };
    }
  }
  return null;
}

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

/**
 * POST /api/onboarding/age/google
 *
 * Best-effort silent age verification for Google sign-ups. The web client
 * forwards the short-lived `provider_token` Supabase exposes on the first
 * OAuth callback; we exchange it for the user's birthday via the People API.
 *
 * Three outcomes:
 *  - Google returned a full birthday → store and return the derived status.
 *  - Google returned nothing usable  → return requiresManualEntry=true so
 *    the client redirects to the manual screen. Nothing is stored.
 *  - Network or upstream failure     → return requiresManualEntry=true with
 *    a 502 so the user is never stuck on a half-finished onboarding.
 *
 * If the feature flag is off this is a no-op.
 */
export const POST = withAuth(async (request: NextRequest, user: AuthenticatedUser) => {
  const origin = request.headers.get("origin");
  const ctx = requestContext(request, "onboarding.age.google");

  try {
    const config = getAgeVerificationConfig();

    if (!config.enabled) {
      return respondJson<GoogleAgePayload>(
        {
          requiresManualEntry: false,
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
        "Something went wrong verifying your age. Please continue manually.",
      );
    }

    const providerToken = (body as { providerToken?: unknown })?.providerToken;
    if (typeof providerToken !== "string" || providerToken.length === 0) {
      throw badRequest(
        "providerToken is required",
        "Something went wrong verifying your age. Please continue manually.",
      );
    }

    const supabase = getSupabase();

    // If we already have a DOB on file (e.g. user clicked Google again after
    // already verifying), return current status and skip the People API call.
    const existing = await supabase
      .from("user_settings")
      .select("date_of_birth")
      .eq("user_id", user.id)
      .maybeSingle();
    if (existing.error) throw existing.error;
    const existingDob = existing.data?.date_of_birth as string | null | undefined;
    if (existingDob) {
      const dob = new Date(`${existingDob}T00:00:00Z`);
      return respondJson<GoogleAgePayload>(
        {
          requiresManualEntry: false,
          ageVerification: {
            enabled: true,
            status: deriveStatus(dob, config.minimumAge),
            minimumAge: config.minimumAge,
            dateOfBirth: existingDob,
          },
        },
        { requestId: ctx.requestId, origin },
      );
    }

    // Fetch the user's birthday from Google. Any non-200 (denied scope,
    // expired token, network blip) is treated as "no usable data" and falls
    // through to manual entry — the worst-case UX is the user fills in DOB
    // themselves, which is still a valid happy path.
    let googleResponse: Response;
    try {
      googleResponse = await fetch(PEOPLE_API_URL, {
        headers: { Authorization: `Bearer ${providerToken}` },
      });
    } catch (err) {
      ctx.log.warn("Google People API request failed", {}, err);
      return respondJson<GoogleAgePayload>(
        {
          requiresManualEntry: true,
          ageVerification: {
            enabled: true,
            status: "pending",
            minimumAge: config.minimumAge,
            dateOfBirth: null,
          },
        },
        { requestId: ctx.requestId, origin, status: 502 },
      );
    }

    if (!googleResponse.ok) {
      ctx.log.warn("Google People API non-OK response", {
        status: googleResponse.status,
      });
      return respondJson<GoogleAgePayload>(
        {
          requiresManualEntry: true,
          ageVerification: {
            enabled: true,
            status: "pending",
            minimumAge: config.minimumAge,
            dateOfBirth: null,
          },
        },
        { requestId: ctx.requestId, origin },
      );
    }

    const data = (await googleResponse.json()) as GooglePeopleResponse;
    const fullBirthday = pickFullBirthday(data.birthdays);
    if (!fullBirthday) {
      return respondJson<GoogleAgePayload>(
        {
          requiresManualEntry: true,
          ageVerification: {
            enabled: true,
            status: "pending",
            minimumAge: config.minimumAge,
            dateOfBirth: null,
          },
        },
        { requestId: ctx.requestId, origin },
      );
    }

    const dob = new Date(
      Date.UTC(fullBirthday.year, fullBirthday.month - 1, fullBirthday.day),
    );
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

    return respondJson<GoogleAgePayload>(
      {
        requiresManualEntry: false,
        ageVerification: {
          enabled: true,
          status: deriveStatus(dob, config.minimumAge),
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
