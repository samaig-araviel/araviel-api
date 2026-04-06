import { describe, it, expect } from "vitest";
import {
  isClaudeExportFormat,
  transformClaudeExport,
} from "@/lib/claude-export-transform";

describe("isClaudeExportFormat", () => {
  it("returns true for array with chat_messages", () => {
    expect(
      isClaudeExportFormat([{ chat_messages: [], uuid: "1", name: "Test" }])
    ).toBe(true);
  });

  it("returns false for empty array", () => {
    expect(isClaudeExportFormat([])).toBe(false);
  });

  it("returns false for non-array", () => {
    expect(isClaudeExportFormat({})).toBe(false);
    expect(isClaudeExportFormat(null)).toBe(false);
    expect(isClaudeExportFormat("string")).toBe(false);
    expect(isClaudeExportFormat(123)).toBe(false);
  });

  it("returns false for array without chat_messages", () => {
    expect(isClaudeExportFormat([{ messages: [], id: "1" }])).toBe(false);
  });

  it("returns false for array with null first element", () => {
    expect(isClaudeExportFormat([null])).toBe(false);
  });
});

describe("transformClaudeExport", () => {
  it("transforms Claude conversations to import format", () => {
    const raw = [
      {
        uuid: "conv-1",
        name: "Test Chat",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T01:00:00Z",
        chat_messages: [
          {
            uuid: "msg-1",
            sender: "human",
            text: "Hello",
            created_at: "2024-01-01T00:00:00Z",
          },
          {
            uuid: "msg-2",
            sender: "assistant",
            text: "Hi there!",
            created_at: "2024-01-01T00:01:00Z",
          },
        ],
      },
    ];

    const result = transformClaudeExport(raw);
    expect(result.conversations).toHaveLength(1);

    const conv = result.conversations[0];
    expect(conv.externalId).toBe("conv-1");
    expect(conv.title).toBe("Test Chat");
    expect(conv.provider).toBe("claude");
    expect(conv.providerName).toBe("Claude");
    expect(conv.messageCount).toBe(2);
    expect(conv.createdAt).toBe("2024-01-01T00:00:00Z");
    expect(conv.updatedAt).toBe("2024-01-01T01:00:00Z");
  });

  it("maps human sender to user role", () => {
    const raw = [
      {
        uuid: "conv-1",
        name: "Test",
        created_at: "",
        updated_at: "",
        chat_messages: [
          { uuid: "msg-1", sender: "human", text: "Hi", created_at: "" },
        ],
      },
    ];

    const result = transformClaudeExport(raw);
    expect(result.conversations[0].messages[0].role).toBe("user");
  });

  it("maps assistant sender to assistant role", () => {
    const raw = [
      {
        uuid: "conv-1",
        name: "Test",
        created_at: "",
        updated_at: "",
        chat_messages: [
          { uuid: "msg-1", sender: "assistant", text: "Hello", created_at: "" },
        ],
      },
    ];

    const result = transformClaudeExport(raw);
    expect(result.conversations[0].messages[0].role).toBe("assistant");
  });

  it("extracts content from content blocks array", () => {
    const raw = [
      {
        uuid: "conv-1",
        name: "Test",
        created_at: "",
        updated_at: "",
        chat_messages: [
          {
            uuid: "msg-1",
            sender: "human",
            text: "",
            created_at: "",
            content: [
              { type: "text", text: "First block" },
              { type: "image", text: undefined },
              { type: "text", text: "Second block" },
            ],
          },
        ],
      },
    ];

    const result = transformClaudeExport(raw);
    expect(result.conversations[0].messages[0].content).toBe(
      "First block\nSecond block"
    );
  });

  it("falls back to text field when content blocks are empty", () => {
    const raw = [
      {
        uuid: "conv-1",
        name: "Test",
        created_at: "",
        updated_at: "",
        chat_messages: [
          {
            uuid: "msg-1",
            sender: "human",
            text: "Fallback text",
            created_at: "",
            content: [],
          },
        ],
      },
    ];

    const result = transformClaudeExport(raw);
    expect(result.conversations[0].messages[0].content).toBe("Fallback text");
  });

  it("filters out messages with empty content", () => {
    const raw = [
      {
        uuid: "conv-1",
        name: "Test",
        created_at: "",
        updated_at: "",
        chat_messages: [
          { uuid: "msg-1", sender: "human", text: "", created_at: "" },
          { uuid: "msg-2", sender: "human", text: "Valid", created_at: "" },
        ],
      },
    ];

    const result = transformClaudeExport(raw);
    expect(result.conversations[0].messages).toHaveLength(1);
    expect(result.conversations[0].messageCount).toBe(1);
  });

  it("uses Untitled Conversation when name is missing", () => {
    const raw = [
      {
        uuid: "conv-1",
        name: "",
        created_at: "",
        updated_at: "",
        chat_messages: [
          { uuid: "msg-1", sender: "human", text: "Hi", created_at: "" },
        ],
      },
    ];

    const result = transformClaudeExport(raw);
    expect(result.conversations[0].title).toBe("Untitled Conversation");
  });

  it("handles missing chat_messages gracefully", () => {
    const raw = [
      {
        uuid: "conv-1",
        name: "No Messages",
        created_at: "",
        updated_at: "",
        chat_messages: undefined as unknown as [],
      },
    ];

    const result = transformClaudeExport(raw);
    expect(result.conversations[0].messages).toHaveLength(0);
  });
});
