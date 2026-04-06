import { describe, it, expect } from "vitest";
import {
  validateConversationInput,
  toResponse,
} from "@/lib/imported-conversations";
import type { ImportedConversationRow } from "@/lib/imported-conversations";

describe("validateConversationInput", () => {
  const validConv = {
    provider: "claude",
    providerName: "Claude",
    title: "Test Conversation",
    messages: [{ id: "1", role: "user", content: "Hi" }],
    messageCount: 1,
  };

  it("returns null for valid input", () => {
    expect(validateConversationInput(validConv, 0)).toBeNull();
  });

  describe("provider validation", () => {
    it("rejects missing provider", () => {
      const input = { ...validConv, provider: undefined };
      expect(validateConversationInput(input, 0)).toContain("provider");
    });

    it("rejects empty provider", () => {
      const input = { ...validConv, provider: "" };
      expect(validateConversationInput(input, 0)).toContain("provider");
    });

    it("rejects non-string provider", () => {
      const input = { ...validConv, provider: 123 };
      expect(validateConversationInput(input, 0)).toContain("provider");
    });

    it("rejects whitespace-only provider", () => {
      const input = { ...validConv, provider: "   " };
      expect(validateConversationInput(input, 0)).toContain("provider");
    });
  });

  describe("providerName validation", () => {
    it("rejects missing providerName", () => {
      const input = { ...validConv, providerName: undefined };
      expect(validateConversationInput(input, 0)).toContain("providerName");
    });

    it("rejects empty providerName", () => {
      const input = { ...validConv, providerName: "" };
      expect(validateConversationInput(input, 0)).toContain("providerName");
    });
  });

  describe("title validation", () => {
    it("rejects missing title", () => {
      const input = { ...validConv, title: undefined };
      expect(validateConversationInput(input, 0)).toContain("title");
    });

    it("rejects empty title", () => {
      const input = { ...validConv, title: "" };
      expect(validateConversationInput(input, 0)).toContain("title");
    });
  });

  describe("messages validation", () => {
    it("rejects missing messages", () => {
      const input = { ...validConv, messages: undefined };
      expect(validateConversationInput(input, 0)).toContain("messages");
    });

    it("rejects empty messages array", () => {
      const input = { ...validConv, messages: [] };
      expect(validateConversationInput(input, 0)).toContain("messages");
    });

    it("rejects non-array messages", () => {
      const input = { ...validConv, messages: "not array" };
      expect(validateConversationInput(input, 0)).toContain("messages");
    });
  });

  describe("messageCount validation", () => {
    it("rejects missing messageCount", () => {
      const input = { ...validConv, messageCount: undefined };
      expect(validateConversationInput(input, 0)).toContain("messageCount");
    });

    it("rejects zero messageCount", () => {
      const input = { ...validConv, messageCount: 0 };
      expect(validateConversationInput(input, 0)).toContain("messageCount");
    });

    it("rejects negative messageCount", () => {
      const input = { ...validConv, messageCount: -1 };
      expect(validateConversationInput(input, 0)).toContain("messageCount");
    });

    it("rejects non-integer messageCount", () => {
      const input = { ...validConv, messageCount: 1.5 };
      expect(validateConversationInput(input, 0)).toContain("messageCount");
    });

    it("rejects string messageCount", () => {
      const input = { ...validConv, messageCount: "1" };
      expect(validateConversationInput(input, 0)).toContain("messageCount");
    });
  });

  describe("index in error message", () => {
    it("includes the correct index", () => {
      const input = { ...validConv, provider: "" };
      expect(validateConversationInput(input, 5)).toContain(
        "conversations[5]"
      );
    });
  });
});

describe("toResponse", () => {
  it("maps snake_case DB row to camelCase response", () => {
    const row: ImportedConversationRow = {
      id: "row-1",
      provider: "claude",
      provider_name: "Claude",
      external_id: "ext-1",
      title: "Test Conversation",
      message_count: 10,
      is_starred: true,
      is_archived: false,
      deleted_at: null,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-02T00:00:00Z",
    };

    const response = toResponse(row);

    expect(response.id).toBe("row-1");
    expect(response.provider).toBe("claude");
    expect(response.providerName).toBe("Claude");
    expect(response.externalId).toBe("ext-1");
    expect(response.title).toBe("Test Conversation");
    expect(response.messageCount).toBe(10);
    expect(response.isStarred).toBe(true);
    expect(response.isArchived).toBe(false);
    expect(response.createdAt).toBe("2024-01-01T00:00:00Z");
    expect(response.updatedAt).toBe("2024-01-02T00:00:00Z");
  });

  it("handles null external_id", () => {
    const row: ImportedConversationRow = {
      id: "row-2",
      provider: "chatgpt",
      provider_name: "ChatGPT",
      external_id: null,
      title: "No External ID",
      message_count: 5,
      is_starred: false,
      is_archived: true,
      deleted_at: null,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    };

    const response = toResponse(row);
    expect(response.externalId).toBeNull();
  });
});
