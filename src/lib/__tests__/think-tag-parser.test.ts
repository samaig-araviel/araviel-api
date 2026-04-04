import { describe, it, expect } from "vitest";
import { ThinkTagParser } from "@/lib/stream/think-tag-parser";
import type { ParsedChunk } from "@/lib/stream/think-tag-parser";

describe("ThinkTagParser", () => {
  function parseAll(chunks: string[]): ParsedChunk[] {
    const parser = new ThinkTagParser();
    const results: ParsedChunk[] = [];
    for (const chunk of chunks) {
      results.push(...parser.push(chunk));
    }
    results.push(...parser.flush());
    return results;
  }

  function parseOne(text: string): ParsedChunk[] {
    return parseAll([text]);
  }

  describe("content without think tags", () => {
    it("passes through plain text as delta", () => {
      const results = parseOne("Hello, world!");
      expect(results).toEqual([{ type: "delta", content: "Hello, world!" }]);
    });

    it("passes through text with angle brackets that are not think tags", () => {
      const results = parseOne("a < b and c > d");
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe("delta");
    });

    it("handles empty string", () => {
      const results = parseOne("");
      expect(results).toHaveLength(0);
    });
  });

  describe("complete think tags in single chunk", () => {
    it("extracts thinking content", () => {
      const results = parseOne("<think>reasoning here</think>after");
      const thinking = results.filter((r) => r.type === "thinking");
      const delta = results.filter((r) => r.type === "delta");
      expect(thinking.length).toBeGreaterThan(0);
      expect(thinking.map((t) => t.content).join("")).toBe("reasoning here");
      expect(delta.map((d) => d.content).join("")).toBe("after");
    });

    it("handles content before think tag", () => {
      const results = parseOne("before<think>thinking</think>");
      const delta = results.filter((r) => r.type === "delta");
      const thinking = results.filter((r) => r.type === "thinking");
      expect(delta.map((d) => d.content).join("")).toBe("before");
      expect(thinking.map((t) => t.content).join("")).toBe("thinking");
    });

    it("handles content before, inside, and after", () => {
      const results = parseOne("before<think>inside</think>after");
      const allContent = results.map((r) => r.content).join("");
      expect(allContent).toBe("beforeinsideafter");
    });
  });

  describe("streaming chunks (split across boundaries)", () => {
    it("handles think tag split across chunks", () => {
      const results = parseAll(["<thi", "nk>thinking content</think>"]);
      const thinking = results.filter((r) => r.type === "thinking");
      expect(thinking.map((t) => t.content).join("")).toBe("thinking content");
    });

    it("handles close tag split across chunks", () => {
      const results = parseAll(["<think>thinking</thi", "nk>done"]);
      const thinking = results.filter((r) => r.type === "thinking");
      const delta = results.filter((r) => r.type === "delta");
      expect(thinking.map((t) => t.content).join("")).toBe("thinking");
      expect(delta.map((d) => d.content).join("")).toBe("done");
    });

    it("handles character-by-character streaming", () => {
      const text = "<think>hi</think>ok";
      const chars = text.split("");
      const results = parseAll(chars);
      const thinking = results.filter((r) => r.type === "thinking");
      const delta = results.filter((r) => r.type === "delta");
      expect(thinking.map((t) => t.content).join("")).toBe("hi");
      expect(delta.map((d) => d.content).join("")).toBe("ok");
    });
  });

  describe("multiple think blocks", () => {
    it("handles two separate think blocks", () => {
      const results = parseOne(
        "a<think>first</think>b<think>second</think>c"
      );
      const thinking = results.filter((r) => r.type === "thinking");
      const delta = results.filter((r) => r.type === "delta");
      expect(thinking.map((t) => t.content).join("")).toBe("firstsecond");
      expect(delta.map((d) => d.content).join("")).toBe("abc");
    });
  });

  describe("false positives (non-think angle brackets)", () => {
    it("handles < that does not start a think tag", () => {
      const results = parseOne("x < y");
      expect(results.map((r) => r.content).join("")).toBe("x < y");
      expect(results.every((r) => r.type === "delta")).toBe(true);
    });

    it("handles <th that is not <think>", () => {
      const results = parseOne("<th>header</th>");
      expect(results.map((r) => r.content).join("")).toBe("<th>header</th>");
    });
  });

  describe("flush", () => {
    it("flushes buffered content on stream end", () => {
      const parser = new ThinkTagParser();
      parser.push("<thi"); // partial open tag
      const flushed = parser.flush();
      expect(flushed.length).toBeGreaterThan(0);
      expect(flushed[0].content).toBe("<thi");
      expect(flushed[0].type).toBe("delta");
    });

    it("flushes thinking buffer for incomplete close tag", () => {
      const parser = new ThinkTagParser();
      parser.push("<think>thinking</thi");
      const flushed = parser.flush();
      // The incomplete close tag buffer should be flushed as thinking
      expect(flushed.some((r) => r.type === "thinking")).toBe(true);
    });

    it("resets parser state after flush", () => {
      const parser = new ThinkTagParser();
      parser.push("<think>test");
      parser.flush();
      // After flush, new content should be delta
      const results = parser.push("normal text");
      expect(results[0].type).toBe("delta");
    });
  });
});
