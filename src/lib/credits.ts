import { getSupabase } from "./supabase";

// ─── Constants ─────────────────────────────────────────────────────────────

export const TIER_MONTHLY_CREDITS: Record<string, number> = {
  free: 5,
  pro: 50,
  premium: 200,
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
    .gt("expires_at", new Date().toISOString())
    .lt("credits_used", sb.rpc ? 0 : 999999); // We'll filter in JS

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
 * Deducts from monthly first, then oldest non-expired pack (FIFO).
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
  const account = await getOrCreateAccount(userId);
  const sb = getSupabase();

  const monthlyRemaining = account.monthly_image_credits - account.monthly_image_credits_used;

  if (monthlyRemaining >= cost) {
    // Charge from monthly
    await sb
      .from("credit_accounts")
      .update({
        monthly_image_credits_used: account.monthly_image_credits_used + cost,
        updated_at: new Date().toISOString(),
      })
      .eq("id", account.id);

    // Log usage
    await sb.from("credit_usage_log").insert({
      user_id: userId,
      feature: "image",
      quality,
      credits_charged: cost,
      source: "monthly",
      model_used: metadata.modelUsed ?? null,
      provider: metadata.provider ?? null,
      conversation_id: metadata.conversationId ?? null,
      message_id: metadata.messageId ?? null,
      prompt_snippet: metadata.prompt?.slice(0, 100) ?? null,
    });

    const updatedBalance = await getBalance(userId);
    return {
      charged: true,
      creditsCharged: cost,
      source: "monthly",
      remainingBalance: updatedBalance.combined,
    };
  }

  // Not enough monthly — charge from oldest pack
  const { data: packs } = await sb
    .from("credit_packs")
    .select("*")
    .eq("user_id", userId)
    .eq("feature", "image")
    .gt("expires_at", new Date().toISOString())
    .order("purchased_at", { ascending: true });

  const activePack = (packs ?? []).find(
    (p: { credits_total: number; credits_used: number }) => p.credits_total - p.credits_used >= cost
  );

  if (!activePack) {
    // Try splitting: use remaining monthly + pack
    if (monthlyRemaining > 0) {
      const fromPack = cost - monthlyRemaining;
      const packForSplit = (packs ?? []).find(
        (p: { credits_total: number; credits_used: number }) =>
          p.credits_total - p.credits_used >= fromPack
      );

      if (packForSplit) {
        // Charge monthly remainder
        await sb
          .from("credit_accounts")
          .update({
            monthly_image_credits_used: account.monthly_image_credits,
            updated_at: new Date().toISOString(),
          })
          .eq("id", account.id);

        // Charge from pack
        await sb
          .from("credit_packs")
          .update({ credits_used: packForSplit.credits_used + fromPack })
          .eq("id", packForSplit.id);

        // Log both
        await sb.from("credit_usage_log").insert({
          user_id: userId,
          feature: "image",
          quality,
          credits_charged: monthlyRemaining,
          source: "monthly",
          model_used: metadata.modelUsed ?? null,
          provider: metadata.provider ?? null,
          conversation_id: metadata.conversationId ?? null,
          message_id: metadata.messageId ?? null,
          prompt_snippet: metadata.prompt?.slice(0, 100) ?? null,
        });
        await sb.from("credit_usage_log").insert({
          user_id: userId,
          feature: "image",
          quality,
          credits_charged: fromPack,
          source: "pack",
          source_id: packForSplit.id,
          model_used: metadata.modelUsed ?? null,
          provider: metadata.provider ?? null,
          conversation_id: metadata.conversationId ?? null,
          message_id: metadata.messageId ?? null,
          prompt_snippet: metadata.prompt?.slice(0, 100) ?? null,
        });

        const updatedBalance = await getBalance(userId);
        return {
          charged: true,
          creditsCharged: cost,
          source: "pack",
          sourceId: packForSplit.id,
          remainingBalance: updatedBalance.combined,
        };
      }
    }

    return {
      charged: false,
      creditsCharged: 0,
      source: "monthly",
      remainingBalance: monthlyRemaining,
    };
  }

  // Charge from pack
  await sb
    .from("credit_packs")
    .update({ credits_used: activePack.credits_used + cost })
    .eq("id", activePack.id);

  // Log usage
  await sb.from("credit_usage_log").insert({
    user_id: userId,
    feature: "image",
    quality,
    credits_charged: cost,
    source: "pack",
    source_id: activePack.id,
    model_used: metadata.modelUsed ?? null,
    provider: metadata.provider ?? null,
    conversation_id: metadata.conversationId ?? null,
    message_id: metadata.messageId ?? null,
    prompt_snippet: metadata.prompt?.slice(0, 100) ?? null,
  });

  const updatedBalance = await getBalance(userId);
  return {
    charged: true,
    creditsCharged: cost,
    source: "pack",
    sourceId: activePack.id,
    remainingBalance: updatedBalance.combined,
  };
}

/**
 * Add a credit pack for a user.
 */
export async function addPack(
  userId: string,
  packType: string
): Promise<{ packId: string; credits: number; expiresAt: string }> {
  const packDef = PACK_DEFINITIONS[packType];
  if (!packDef) throw new Error(`Unknown pack type: ${packType}`);

  const sb = getSupabase();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PACK_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  // Create transaction record
  const { data: txn, error: txnError } = await sb
    .from("credit_transactions")
    .insert({
      user_id: userId,
      pack_type: packType,
      feature: "image",
      credits: packDef.credits,
      amount_cents: 0, // Free for now
      status: "completed",
      completed_at: now.toISOString(),
    })
    .select("id")
    .single();

  if (txnError) throw new Error(`Failed to create transaction: ${txnError.message}`);

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

  if (packError) throw new Error(`Failed to create pack: ${packError.message}`);

  // Ensure account exists
  await getOrCreateAccount(userId);

  return {
    packId: pack.id,
    credits: packDef.credits,
    expiresAt: expiresAt.toISOString(),
  };
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
