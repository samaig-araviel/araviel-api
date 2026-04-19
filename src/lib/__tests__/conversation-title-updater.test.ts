import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The module under test reads `process.env.NEXT_PUBLIC_SUPABASE_URL` and
// `SUPABASE_SERVICE_ROLE_KEY` via @/lib/supabase. We mock @/lib/supabase
// directly to isolate the unit from the Supabase client and the env vars.

type UpdateChain = {
  update: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
};

function makeSupabaseMock(result: {
  data: Array<{ id: string }> | null;
  error: { message: string } | null;
}): { client: { from: ReturnType<typeof vi.fn> }; chain: UpdateChain } {
  const chain: UpdateChain = {
    update: vi.fn(),
    eq: vi.fn(),
    select: vi.fn(),
  };
  chain.update.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.select.mockResolvedValue(result);
  const client = {
    from: vi.fn().mockReturnValue(chain),
  };
  return { client, chain };
}

describe("updateConversationTitleIfUnchanged", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true when the row matched the expected title and was updated", async () => {
    const { client } = makeSupabaseMock({
      data: [{ id: "conv-1" }],
      error: null,
    });
    vi.doMock("@/lib/supabase", () => ({
      getSupabase: () => client,
    }));

    const { updateConversationTitleIfUnchanged } = await import(
      "@/lib/conversation-title-updater"
    );
    const result = await updateConversationTitleIfUnchanged(
      "conv-1",
      "placeholder...",
      "Clean descriptive title"
    );
    expect(result).toBe(true);
    expect(client.from).toHaveBeenCalledWith("conversations");
  });

  it("returns false when no row matched (title already changed)", async () => {
    const { client } = makeSupabaseMock({ data: [], error: null });
    vi.doMock("@/lib/supabase", () => ({
      getSupabase: () => client,
    }));

    const { updateConversationTitleIfUnchanged } = await import(
      "@/lib/conversation-title-updater"
    );
    const result = await updateConversationTitleIfUnchanged(
      "conv-1",
      "placeholder...",
      "Clean descriptive title"
    );
    expect(result).toBe(false);
  });

  it("returns false (does not throw) when the DB returns an error", async () => {
    const { client } = makeSupabaseMock({
      data: null,
      error: { message: "db unavailable" },
    });
    vi.doMock("@/lib/supabase", () => ({
      getSupabase: () => client,
    }));

    const { updateConversationTitleIfUnchanged } = await import(
      "@/lib/conversation-title-updater"
    );
    const result = await updateConversationTitleIfUnchanged(
      "conv-1",
      "placeholder...",
      "Clean descriptive title"
    );
    expect(result).toBe(false);
  });

  it("returns false without calling the DB when placeholder equals new title", async () => {
    const { client } = makeSupabaseMock({
      data: [{ id: "conv-1" }],
      error: null,
    });
    vi.doMock("@/lib/supabase", () => ({
      getSupabase: () => client,
    }));

    const { updateConversationTitleIfUnchanged } = await import(
      "@/lib/conversation-title-updater"
    );
    const result = await updateConversationTitleIfUnchanged(
      "conv-1",
      "same",
      "same"
    );
    expect(result).toBe(false);
    expect(client.from).not.toHaveBeenCalled();
  });

  it("returns false (does not throw) if the client throws unexpectedly", async () => {
    vi.doMock("@/lib/supabase", () => ({
      getSupabase: () => {
        throw new Error("service role key missing");
      },
    }));

    const { updateConversationTitleIfUnchanged } = await import(
      "@/lib/conversation-title-updater"
    );
    const result = await updateConversationTitleIfUnchanged(
      "conv-1",
      "placeholder",
      "new title"
    );
    expect(result).toBe(false);
  });
});
