import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

/**
 * Authenticated user extracted from a validated Supabase JWT.
 */
export interface AuthenticatedUser {
  id: string;
  email?: string;
  isAnonymous: boolean;
}

/**
 * Typed authentication error with HTTP status code.
 */
export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status: number = 401
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * Validate the Authorization header and return the authenticated user.
 *
 * Uses `supabase.auth.getUser(token)` which makes a server-side call to
 * verify the JWT against Supabase's auth service. This catches expired
 * and revoked tokens, unlike local JWT decoding.
 */
export async function authenticateRequest(
  request: NextRequest
): Promise<AuthenticatedUser> {
  const authHeader = request.headers.get("authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new AuthError(
      "Missing or invalid Authorization header. Use format: Bearer <token>",
      401
    );
  }

  const token = authHeader.slice(7);

  if (!token) {
    throw new AuthError("Empty bearer token", 401);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new AuthError("Server auth configuration error", 500);
  }

  // Create a throwaway client scoped to this request's token.
  // Using the anon key + user token means RLS policies apply.
  const supabase = createClient(url, anonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    throw new AuthError("Invalid or expired authentication token", 401);
  }

  return {
    id: user.id,
    email: user.email,
    isAnonymous: user.is_anonymous ?? false,
  };
}

/**
 * Extract the raw bearer token from a request. Returns null if absent.
 */
export function extractBearerToken(request: NextRequest): string | null {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7) || null;
}

/**
 * Higher-order wrapper that authenticates a route handler.
 * Routes wrapped with this require a valid Supabase JWT.
 *
 * Usage:
 *   export const GET = withAuth(async (request, user) => { ... });
 */
export function withAuth<
  TArgs extends unknown[] = []
>(
  handler: (
    request: NextRequest,
    user: AuthenticatedUser,
    ...args: TArgs
  ) => Promise<Response>
) {
  return async (request: NextRequest, ...args: TArgs): Promise<Response> => {
    try {
      const user = await authenticateRequest(request);
      return await handler(request, user, ...args);
    } catch (err) {
      if (err instanceof AuthError) {
        return NextResponse.json(
          { error: err.message },
          { status: err.status }
        );
      }
      throw err;
    }
  };
}
