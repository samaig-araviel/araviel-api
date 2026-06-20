import { describe, it, expect } from "vitest";
import { detectImageAspectRatio } from "@/lib/image-aspect-ratio";

describe("detectImageAspectRatio", () => {
  it("defaults to 1:1 when the prompt is empty", () => {
    expect(detectImageAspectRatio("")).toBe("1:1");
  });

  it("defaults to 1:1 when no orientation cue is present", () => {
    expect(detectImageAspectRatio("a watercolor painting of a sunrise")).toBe("1:1");
    expect(detectImageAspectRatio("draw a cat")).toBe("1:1");
  });

  describe("9:16 portrait", () => {
    it("detects 'Instagram Story' phrasing", () => {
      expect(detectImageAspectRatio("design a premium Instagram Story poster")).toBe("9:16");
    });

    it("detects explicit 1080 × 1920 dimensions", () => {
      expect(detectImageAspectRatio("Format: 1080 × 1920 vertical")).toBe("9:16");
      expect(detectImageAspectRatio("size 1080x1920")).toBe("9:16");
    });

    it("detects 9:16 ratio notation", () => {
      expect(detectImageAspectRatio("9:16 aspect ratio")).toBe("9:16");
    });

    it("detects 'vertical' and 'portrait' keywords", () => {
      expect(detectImageAspectRatio("a vertical movie poster")).toBe("9:16");
      expect(detectImageAspectRatio("portrait of a woman in a garden")).toBe("9:16");
    });

    it("detects TikTok / Reel / Short formats", () => {
      expect(detectImageAspectRatio("TikTok thumbnail")).toBe("9:16");
      expect(detectImageAspectRatio("Instagram Reel cover")).toBe("9:16");
      expect(detectImageAspectRatio("YouTube Shorts cover")).toBe("9:16");
    });
  });

  describe("16:9 landscape", () => {
    it("detects 'landscape' and 'widescreen' keywords", () => {
      expect(detectImageAspectRatio("landscape painting of mountains")).toBe("16:9");
      expect(detectImageAspectRatio("widescreen poster")).toBe("16:9");
    });

    it("detects explicit 1920 × 1080 dimensions", () => {
      expect(detectImageAspectRatio("size 1920 × 1080")).toBe("16:9");
    });

    it("detects 16:9 ratio notation", () => {
      expect(detectImageAspectRatio("16:9 cinematic shot")).toBe("16:9");
    });

    it("detects YouTube thumbnail / desktop wallpaper cues", () => {
      expect(detectImageAspectRatio("YouTube thumbnail design")).toBe("16:9");
      expect(detectImageAspectRatio("desktop wallpaper of a forest")).toBe("16:9");
    });
  });

  describe("21:9 ultrawide and 9:21 tall", () => {
    it("detects 'ultrawide' and 'cinematic' for 21:9", () => {
      expect(detectImageAspectRatio("an ultrawide banner")).toBe("21:9");
    });

    it("detects 'vertical banner' for 9:21", () => {
      expect(detectImageAspectRatio("a vertical banner for a website")).toBe("9:21");
    });

    it("prefers 9:21 over 9:16 when both could match", () => {
      // "vertical banner" must win over generic "vertical"
      expect(detectImageAspectRatio("vertical banner")).toBe("9:21");
    });
  });

  describe("4:3 and 3:4", () => {
    it("detects 4:3 ratio", () => {
      expect(detectImageAspectRatio("4:3 landscape photo")).toBe("4:3");
    });

    it("detects 3:4 ratio", () => {
      expect(detectImageAspectRatio("3:4 portrait of a dog")).toBe("3:4");
    });
  });

  describe("1:1 square", () => {
    it("detects 'square'", () => {
      expect(detectImageAspectRatio("a square logo")).toBe("1:1");
    });

    it("detects 1:1 ratio notation", () => {
      expect(detectImageAspectRatio("1:1 album art")).toBe("1:1");
    });

    it("detects Instagram post and profile picture", () => {
      expect(detectImageAspectRatio("Instagram post design")).toBe("1:1");
      expect(detectImageAspectRatio("a profile picture")).toBe("1:1");
    });
  });

  it("handles the long ARAVEIL prompt and picks 9:16", () => {
    const prompt = `Create a premium Instagram Story marketing poster for ARAVEIL, a next-generation AI platform that brings the world's best AI models into one intelligent workspace.

Use a bold, editorial visual style inspired by leading AI companies. The design should feel confident, minimal, highly technical and product-led.

Format: 1080 × 1920 vertical Instagram Story.`;
    expect(detectImageAspectRatio(prompt)).toBe("9:16");
  });
});
