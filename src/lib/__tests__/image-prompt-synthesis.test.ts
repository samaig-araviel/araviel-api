import { describe, it, expect, vi } from "vitest";
import { synthesizeImagePrompt } from "@/lib/image-prompt-synthesis";
import type { ConversationMessage } from "@/lib/types";

type MockClient = {
  chat: { completions: { create: ReturnType<typeof vi.fn> } };
};

function mockClient(reply: string | (() => Promise<unknown>)): MockClient {
  const create = vi.fn().mockImplementation(async () => {
    if (typeof reply === "function") return reply();
    return { choices: [{ message: { content: reply } }] };
  });
  return { chat: { completions: { create } } };
}

describe("synthesizeImagePrompt", () => {
  const userMsg = "generate the image";

  it("returns the synthesized prompt + aspect ratio when the model responds", async () => {
    const history: ConversationMessage[] = [
      { role: "user", content: "Design a vertical Instagram flyer for Map Groups" },
      { role: "assistant", content: "Done. Title is bold, two QR cards, 1080x1350." },
      { role: "user", content: userMsg },
    ];
    const client = mockClient(
      JSON.stringify({
        prompt:
          "A vertical Instagram flyer at 1080x1350 for Map Groups, bold sans-serif title, two QR cards left and right, modern minimalist composition.",
        aspectRatio: "9:16",
      })
    );

    const result = await synthesizeImagePrompt({ history, userMessage: userMsg, client });

    expect(result.prompt).toContain("Map Groups");
    expect(result.prompt).toContain("1080x1350");
    expect(result.aspectRatio).toBe("9:16");
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it("passes a windowed history transcript to the model", async () => {
    const history: ConversationMessage[] = Array.from({ length: 15 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as ConversationMessage["role"],
      content: `turn-${i}`,
    }));
    const client = mockClient(JSON.stringify({ prompt: "prompt", aspectRatio: "1:1" }));

    await synthesizeImagePrompt({ history, userMessage: userMsg, client });

    const sentMessages = client.chat.completions.create.mock.calls[0][0].messages;
    const userBlock = sentMessages.find((m: { role: string }) => m.role === "user")
      ?.content as string;
    expect(userBlock).toContain("turn-14");
    expect(userBlock).toContain("turn-5");
    expect(userBlock).not.toContain("turn-0");
  });

  it("describes image-only turns rather than emitting empty lines", async () => {
    const history: ConversationMessage[] = [
      {
        role: "user",
        content: "",
        images: [{ dataUri: "data:image/jpeg;base64,A", mimeType: "image/jpeg" }],
      },
      { role: "assistant", content: "Got it." },
      { role: "user", content: userMsg },
    ];
    const client = mockClient(JSON.stringify({ prompt: "prompt", aspectRatio: "1:1" }));

    await synthesizeImagePrompt({ history, userMessage: userMsg, client });

    const userBlock = client.chat.completions.create.mock.calls[0][0].messages[1]
      .content as string;
    expect(userBlock).toContain("[1 attached image]");
  });

  it("falls back to the user message when the model returns empty content", async () => {
    const client = mockClient("");
    const result = await synthesizeImagePrompt({
      history: [{ role: "user", content: userMsg }],
      userMessage: userMsg,
      client,
    });
    expect(result.prompt).toBe(userMsg);
    expect(result.aspectRatio).toBeUndefined();
  });

  it("falls back to the user message when the model returns unparseable JSON", async () => {
    const client = mockClient("not json at all");
    const result = await synthesizeImagePrompt({
      history: [{ role: "user", content: userMsg }],
      userMessage: userMsg,
      client,
    });
    expect(result.prompt).toBe(userMsg);
    expect(result.aspectRatio).toBeUndefined();
  });

  it("ignores an invalid aspectRatio value but keeps the prompt", async () => {
    const client = mockClient(
      JSON.stringify({ prompt: "polished prompt", aspectRatio: "5:7" })
    );
    const result = await synthesizeImagePrompt({
      history: [{ role: "user", content: userMsg }],
      userMessage: userMsg,
      client,
    });
    expect(result.prompt).toBe("polished prompt");
    expect(result.aspectRatio).toBeUndefined();
  });

  it("falls back to the user message when the model call throws", async () => {
    const client = mockClient(async () => {
      throw new Error("upstream 500");
    });
    const result = await synthesizeImagePrompt({
      history: [{ role: "user", content: userMsg }],
      userMessage: userMsg,
      client,
    });
    expect(result.prompt).toBe(userMsg);
  });

  it("falls back to the user message when no OpenAI client is available", async () => {
    const result = await synthesizeImagePrompt({
      history: [{ role: "user", content: userMsg }],
      userMessage: userMsg,
      client: undefined,
    });
    expect(result.prompt).toBe(userMsg);
  });

  it("uses a non-history block when history is empty", async () => {
    const client = mockClient(
      JSON.stringify({ prompt: "a polished standalone image prompt", aspectRatio: "1:1" })
    );
    const result = await synthesizeImagePrompt({
      history: [],
      userMessage: "watercolor mountain sunrise, soft pastel pinks",
      client,
    });
    expect(result.prompt).toBe("a polished standalone image prompt");
    const userBlock = client.chat.completions.create.mock.calls[0][0].messages[1]
      .content as string;
    expect(userBlock).toContain("watercolor mountain sunrise");
    expect(userBlock).not.toContain("Conversation so far");
  });
});
