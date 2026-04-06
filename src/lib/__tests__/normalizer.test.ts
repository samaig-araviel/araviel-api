import { describe, it, expect } from "vitest";
import { formatSSE, createSSEStream, sendSSE } from "@/lib/stream/normalizer";
import type { StreamEvent } from "@/lib/types";

describe("formatSSE", () => {
  it("formats an event as SSE data line", () => {
    const event: StreamEvent = {
      type: "delta",
      data: { content: "hello" },
    };
    const result = formatSSE(event);
    expect(result).toBe('data: {"type":"delta","data":{"content":"hello"}}\n\n');
  });

  it("starts with 'data: ' prefix", () => {
    const event: StreamEvent = { type: "done", data: {} };
    expect(formatSSE(event).startsWith("data: ")).toBe(true);
  });

  it("ends with double newline", () => {
    const event: StreamEvent = { type: "error", data: { message: "fail" } };
    expect(formatSSE(event).endsWith("\n\n")).toBe(true);
  });

  it("produces valid JSON after 'data: ' prefix", () => {
    const event: StreamEvent = {
      type: "routing",
      data: { model: "gpt-4o", score: 0.95 },
    };
    const json = formatSSE(event).slice(6, -2); // strip "data: " and "\n\n"
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json);
    expect(parsed.type).toBe("routing");
    expect(parsed.data.model).toBe("gpt-4o");
  });
});

describe("createSSEStream", () => {
  it("returns stream, writer, and encoder", () => {
    const { stream, writer, encoder } = createSSEStream();
    expect(stream).toBeInstanceOf(ReadableStream);
    expect(writer).toBeDefined();
    expect(encoder).toBeInstanceOf(TextEncoder);
    writer.close();
  });
});

describe("sendSSE", () => {
  it("encodes and writes formatted SSE data to the writer", async () => {
    const encoder = new TextEncoder();
    const written: Uint8Array[] = [];
    const mockWriter = {
      write: vi.fn((chunk: Uint8Array) => {
        written.push(chunk);
        return Promise.resolve();
      }),
    } as unknown as WritableStreamDefaultWriter<Uint8Array>;

    const event: StreamEvent = { type: "delta", data: { content: "test" } };
    await sendSSE(mockWriter, encoder, event);

    expect(mockWriter.write).toHaveBeenCalledOnce();
    const text = new TextDecoder().decode(written[0]);
    expect(text).toContain('"type":"delta"');
    expect(text).toContain('"content":"test"');
    expect(text).toMatch(/^data: .+\n\n$/);
  });
});
