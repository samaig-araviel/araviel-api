import { getSupabase } from "./supabase";
import { logger } from "./logger";

const log = logger.child({ module: "credits" });

// ─── Constants ─────────────────────────────────────────────────────────────

export const TIER_MONTHLY_CREDITS: Record<string, number> = {
  free: 5,
  lite: 50,
  pro: 150,
};

export const IMAGE_QUALITY_COSTS: Record<string, number> = {
  standard: 1,
  hd: 2,
  ultra: 4,
};

export const PACK_DEFINITIONS: Record<string, { credits: number; label: string }> = {
  starter: { credits: 20, label: "Starter Pack" },
  creator: { credits: 50, label: "Creator Pack" },
  studio: { credits: 100, label: "Studio Pack" },
};

const PACK_EXPIRY_DAYS = 90;
const BILLING_CYCLE_DAYS = 30;

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CreditBalance {
  monthly: { total: number; used: number; remaining: number };
  packs: { total: number; used: number; remaining: number };
  combined: number;
  tier: string;
  cycleResetsAt: string;
}

export interface CanGenerateResult {
  allowed: boolean;
  cost: number;
  balance: number;
  reason?: string;
}

export interface ChargeResult {
  charged: boolean;
  creditsCharged: number;
  source: "monthly" | "pack";
  sourceId?: string;
  remainingBalance: number;
}

// ─── Account Management ────────────────────────────────────────────────────

/**
 * Get or create a credit account for a user.
 * Automatically resets monthly credits if billing cycle has elapsed.
 */
export async function getOrCreateAccount(userId: string) {
  const sb = getSupabase();

  const { data: existing } = await sb
    .from("credit_accounts")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (existing) {
    // Check if billing cycle needs reset
    const cycleStart = new Date(existing.billing_cycle_start);
    const now = new Date();
    const daysSinceCycle = (now.getTime() - cycleStart.getTime()) / (1000 * 60 * 60 * 24);

    if (daysSinceCycle >= BILLING_CYCLE_DAYS) {
      const { data: updated } = await sb
        .from("credit_accounts")
        .update({
          monthly_image_credits_used: 0,
          billing_cycle_start: now.toISOString(),
          updated_at: now.toISOString(),
        })
        .eq("id", existing.id)
        .select("*")
        .single();
      return updated ?? existing;
    }

    return existing;
  }

  // Create new account
  const { data: created, error } = await sb
    .from("credit_accounts")
    .insert({
      user_id: userId,
      tier: "free",
      monthly_image_credits: TIER_MONTHLY_CREDITS.free,
      monthly_image_credits_used: 0,
      billing_cycle_start: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (error) throw new Error(`Failed to create credit account: ${error.message}`);
  return created;
}

/**
 * Get the full credit balance for a user.
 */
export async function getBalance(userId: string): Promise<CreditBalance> {
  const account = await getOrCreateAccount(userId);
  const sb = getSupabase();

  // Get active (non-expired, not fully used) packs
  const { data: packs } = await sb
    .from("credit_packs")
    .select("credits_total, credits_used")
    .eq("user_id", userId)
    .eq("feature", "image")
    .gt("expires_at", new Date().toISOString());

  const activePacks = (packs ?? []).filter(
    (p: { credits_total: number; credits_used: number }) => p.credits_used < p.credits_total
  );
  const packTotal = activePacks.reduce((sum: number, p: { credits_total: number }) => sum + p.credits_total, 0);
  const packUsed = activePacks.reduce((sum: number, p: { credits_used: number }) => sum + p.credits_used, 0);

  const monthlyRemaining = Math.max(0, account.monthly_image_credits - account.monthly_image_credits_used);
  const packRemaining = packTotal - packUsed;

  const cycleStart = new Date(account.billing_cycle_start);
  const cycleResetsAt = new Date(cycleStart.getTime() + BILLING_CYCLE_DAYS * 24 * 60 * 60 * 1000);

  return {
    monthly: {
      total: account.monthly_image_credits,
      used: account.monthly_image_credits_used,
      remaining: monthlyRemaining,
    },
    packs: {
      total: packTotal,
      used: packUsed,
      remaining: packRemaining,
    },
    combined: monthlyRemaining + packRemaining,
    tier: account.tier,
    cycleResetsAt: cycleResetsAt.toISOString(),
  };
}

/**
 * Check whether a user can generate an image at a given quality level.
 */
export async function canGenerate(
  userId: string,
  quality: string = "standard"
): Promise<CanGenerateResult> {
  const cost = IMAGE_QUALITY_COSTS[quality] ?? IMAGE_QUALITY_COSTS.standard;
  const balance = await getBalance(userId);

  if (balance.combined < cost) {
    return {
      allowed: false,
      cost,
      balance: balance.combined,
      reason:
        balance.combined === 0
          ? "No image credits remaining"
          : `Need ${cost} credits but only ${balance.combined} available`,
    };
  }

  return { allowed: true, cost, balance: balance.combined };
}

/**
 * Charge credits for an image generation.
 *
 * Delegates to the `consume_image_credit` Postgres function, which runs the
 * full decision (monthly → pack FIFO → split) under row-level locks in a
 * single transaction. This makes concurrent charges for the same user
 * provably race-free and mirrors how text credits are consumed via
 * `consume_text_credit` (see subscription.ts:checkAndConsumeTextCredit).
 */
export async function chargeCredits(
  userId: string,
  quality: string,
  metadata: {
    modelUsed?: string;
    provider?: string;
    conversationId?: string;
    messageId?: string;
    prompt?: string;
  } = {}
): Promise<ChargeResult> {
  const cost = IMAGE_QUALITY_COSTS[quality] ?? IMAGE_QUALITY_COSTS.standard;
  const sb = getSupabase();

  const { data, error } = await sb.rpc("consume_image_credit", {
    p_user_id: userId,
    p_cost: cost,
    p_quality: quality,
    p_model: metadata.modelUsed ?? null,
    p_provider: metadata.provider ?? null,
    p_conversation_id: metadata.conversationId ?? null,
    p_message_id: metadata.messageId ?? null,
    p_prompt_snippet: metadata.prompt?.slice(0, 100) ?? null,
  });

  if (error) {
    log.error("consume_image_credit RPC failed", error);
    throw new Error(`Failed to charge image credits: ${error.message}`);
  }

  const remainingMonthly = Number(data.remaining_monthly ?? 0);
  const remainingPacks = Number(data.remaining_packs ?? 0);

  return {
    charged: Boolean(data.charged),
    creditsCharged: Number(data.credits_charged ?? 0),
    source: data.source as "monthly" | "pack",
    sourceId: data.source_id ?? undefined,
    remainingBalance: remainingMonthly + remainingPacks,
  };
}

/**
 * Add a credit pack for a user.
 */
export async function addPack(
  userId: string,
  packType: string,
  options?: { amountCents?: number; status?: "pending" | "completed" }
): Promise<{ packId: string; credits: number; expiresAt: string }> {
  log.debug("addPack starting", { userId, packType, amountCents: options?.amountCents, status: options?.status });

  // Validate input
  if (!userId || typeof userId !== "string") {
    throw new Error("Invalid userId: must be a non-empty string");
  }
  if (!packType || typeof packType !== "string") {
    throw new Error("Invalid packType: must be a non-empty string");
  }

  const packDef = PACK_DEFINITIONS[packType];
  if (!packDef) {
    throw new Error(`Invalid pack type: "${packType}". Valid types: ${Object.keys(PACK_DEFINITIONS).join(", ")}`);
  }

  log.debug("addPack validations passed", { packDef });

  // Ensure account exists FIRST before creating pack records
  log.debug("addPack ensuring account", { userId });
  await getOrCreateAccount(userId);
  log.debug("addPack account ready", { userId });

  const sb = getSupabase();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PACK_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  const amountCents = options?.amountCents ?? 0;
  const status = options?.status ?? "completed";

  log.debug("addPack creating transaction", {
    userId,
    packType,
    credits: packDef.credits,
    amountCents,
    status,
  });

  // Create transaction record
  const { data: txn, error: txnError } = await sb
    .from("credit_transactions")
    .insert({
      user_id: userId,
      pack_type: packType,
      feature: "image",
      credits: packDef.credits,
      amount_cents: amountCents,
      status,
      completed_at: status === "completed" ? now.toISOString() : null,
    })
    .select("id")
    .single();

  if (txnError) {
    log.error("addPack transaction insert failed", txnError, { userId, packType });
    throw new Error(`Failed to create transaction: ${txnError.message}`);
  }
  log.info("addPack transaction created", { transactionId: txn.id, userId });

  log.debug("addPack creating pack record", {
    userId,
    transactionId: txn.id,
    creditsTotal: packDef.credits,
    expiresAt: expiresAt.toISOString(),
  });

  // Create pack
  const { data: pack, error: packError } = await sb
    .from("credit_packs")
    .insert({
      user_id: userId,
      transaction_id: txn.id,
      feature: "image",
      credits_total: packDef.credits,
      credits_used: 0,
      purchased_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    })
    .select("id")
    .single();

  if (packError) {
    log.error("addPack pack insert failed", packError, { userId, packType, transactionId: txn.id });
    throw new Error(`Failed to create pack: ${packError.message}`);
  }

  log.info("addPack completed", { packId: pack.id, userId, packType });

  return {
    packId: pack.id,
    credits: packDef.credits,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Reset monthly image credits for a user, anchored to the Stripe billing period.
 * Called by the Stripe webhook on checkout and on each renewal so the cycle
 * is always Stripe-driven — not based on a rolling 30-day calendar from account creation.
 */
export async function resetMonthlyImageCredits(
  userId: string,
  periodStart: string
): Promise<void> {
  const sb = getSupabase();
  const account = await getOrCreateAccount(userId);
  await sb
    .from("credit_accounts")
    .update({
      monthly_image_credits_used: 0,
      billing_cycle_start: periodStart,
      updated_at: new Date().toISOString(),
    })
    .eq("id", account.id);
}

/**
 * Update a user's tier and adjust monthly credits accordingly.
 */
export async function updateTier(userId: string, newTier: string): Promise<void> {
  const monthlyCredits = TIER_MONTHLY_CREDITS[newTier] ?? TIER_MONTHLY_CREDITS.free;
  const sb = getSupabase();

  const account = await getOrCreateAccount(userId);

  await sb
    .from("credit_accounts")
    .update({
      tier: newTier,
      monthly_image_credits: monthlyCredits,
      updated_at: new Date().toISOString(),
    })
    .eq("id", account.id);
}
