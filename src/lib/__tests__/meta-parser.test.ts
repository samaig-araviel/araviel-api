import { describe, it, expect } from "vitest";
import {
  extractAravielMeta,
  containsPartialMeta,
} from "@/lib/stream/meta-parser";

describe("extractAravielMeta", () => {
  describe("no meta block", () => {
    it("returns original content when no meta tag present", () => {
      const result = extractAravielMeta("Hello, world!");
      expect(result.cleanContent).toBe("Hello, world!");
      expect(result.meta).toBeNull();
    });

    it("handles empty string", () => {
      const result = extractAravielMeta("");
      expect(result.cleanContent).toBe("");
      expect(result.meta).toBeNull();
    });
  });

  describe("incomplete meta block", () => {
    it("returns original content when only open tag present", () => {
      const result = extractAravielMeta("Content <araviel_meta> partial");
      expect(result.cleanContent).toBe("Content <araviel_meta> partial");
      expect(result.meta).toBeNull();
    });
  });

  describe("valid meta block with followUps", () => {
    it("extracts follow-up suggestions and strips meta block", () => {
      const content =
        'Here is my response.\n\n<araviel_meta>{"followUps": ["Tell me more", "Show examples"]}</araviel_meta>';
      const result = extractAravielMeta(content);
      expect(result.cleanContent).toBe("Here is my response.");
      expect(result.meta).not.toBeNull();
      expect(result.meta!.followUps).toEqual(["Tell me more", "Show examples"]);
    });

    it("limits follow-ups to 5", () => {
      const followUps = Array.from({ length: 10 }, (_, i) => `Option ${i}`);
      const content = `Response\n\n<araviel_meta>${JSON.stringify({ followUps })}</araviel_meta>`;
      const result = extractAravielMeta(content);
      expect(result.meta!.followUps).toHaveLength(5);
    });

    it("filters out non-string and empty follow-ups", () => {
      const content =
        'Response\n\n<araviel_meta>{"followUps": ["valid", "", 123, null, "also valid"]}</araviel_meta>';
      const result = extractAravielMeta(content);
      expect(result.meta!.followUps).toEqual(["valid", "also valid"]);
    });

    it("trims whitespace from follow-ups", () => {
      const content =
        'Response\n\n<araviel_meta>{"followUps": ["  padded  "]}</araviel_meta>';
      const result = extractAravielMeta(content);
      expect(result.meta!.followUps).toEqual(["padded"]);
    });
  });

  describe("valid meta block with questions", () => {
    it("extracts questions with options", () => {
      const meta = {
        followUps: [],
        questions: [
          {
            question: "Which format?",
            options: ["PDF", "Word", "Excel"],
            multiSelect: false,
          },
        ],
      };
      const content = `Response\n\n<araviel_meta>${JSON.stringify(meta)}</araviel_meta>`;
      const result = extractAravielMeta(content);
      expect(result.meta!.questions).toHaveLength(1);
      expect(result.meta!.questions[0].question).toBe("Which format?");
      expect(result.meta!.questions[0].options).toEqual(["PDF", "Word", "Excel"]);
      expect(result.meta!.questions[0].multiSelect).toBe(false);
    });

    it("filters out questions with no valid options", () => {
      const meta = {
        followUps: [],
        questions: [
          { question: "Valid?", options: ["Yes", "No"] },
          { question: "Invalid?", options: [] },
          { question: "Also invalid", options: [123, null] },
        ],
      };
      const content = `Response\n\n<araviel_meta>${JSON.stringify(meta)}</araviel_meta>`;
      const result = extractAravielMeta(content);
      expect(result.meta!.questions).toHaveLength(1);
      expect(result.meta!.questions[0].question).toBe("Valid?");
    });

    it("limits options to 5 per question", () => {
      const meta = {
        followUps: [],
        questions: [
          {
            question: "Choose:",
            options: ["A", "B", "C", "D", "E", "F", "G"],
          },
        ],
      };
      const content = `Response\n\n<araviel_meta>${JSON.stringify(meta)}</araviel_meta>`;
      const result = extractAravielMeta(content);
      expect(result.meta!.questions[0].options).toHaveLength(5);
    });
  });

  describe("invalid JSON in meta block", () => {
    it("returns cleaned content with null meta for invalid JSON", () => {
      const content =
        "Response\n\n<araviel_meta>not valid json</araviel_meta>";
      const result = extractAravielMeta(content);
      expect(result.cleanContent).toBe("Response");
      expect(result.meta).toBeNull();
    });
  });

  describe("empty meta", () => {
    it("returns null meta when both followUps and questions are empty", () => {
      const content =
        'Response\n\n<araviel_meta>{"followUps": [], "questions": []}</araviel_meta>';
      const result = extractAravielMeta(content);
      expect(result.meta).toBeNull();
    });
  });

  describe("trailing question stripping", () => {
    it("strips trailing question list when questions are in metadata", () => {
      const meta = {
        followUps: [],
        questions: [{ question: "Choose:", options: ["A", "B"] }],
      };
      const content = `Here is my analysis.\n\nWould you like me to:\n- Option A\n- Option B\n\n<araviel_meta>${JSON.stringify(meta)}</araviel_meta>`;
      const result = extractAravielMeta(content);
      expect(result.cleanContent).not.toContain("Would you like me to:");
      expect(result.cleanContent).not.toContain("Option A");
    });
  });
});

describe("containsPartialMeta", () => {
  it("returns false for text without any meta-like content", () => {
    expect(containsPartialMeta("Hello, world!")).toBe(false);
  });

  it("returns true when open tag present without close", () => {
    expect(containsPartialMeta("text <araviel_meta> partial")).toBe(true);
  });

  it("returns false when both open and close tags present", () => {
    expect(
      containsPartialMeta("text <araviel_meta>{}</araviel_meta>")
    ).toBe(false);
  });

  it("returns true for partial opening tag at end", () => {
    expect(containsPartialMeta("text <araviel")).toBe(true);
    expect(containsPartialMeta("text <araviel_")).toBe(true);
    expect(containsPartialMeta("text <araviel_m")).toBe(true);
  });

  it("returns true for single < at end", () => {
    expect(containsPartialMeta("text <")).toBe(true);
  });
});
