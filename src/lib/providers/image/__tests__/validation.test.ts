import { describe, it, expect } from "vitest";
import {
  ImageValidationError,
  validateBackgroundFormat,
  validateImageSize,
} from "@/lib/providers/image/validation";

describe("validateImageSize", () => {
  it("accepts the standard sizes", () => {
    expect(validateImageSize("1024x1024")).toEqual({ width: 1024, height: 1024 });
    expect(validateImageSize("1536x1024")).toEqual({ width: 1536, height: 1024 });
    expect(validateImageSize("1024x1536")).toEqual({ width: 1024, height: 1536 });
  });

  it("accepts arbitrary sizes that satisfy OpenAI constraints", () => {
    expect(validateImageSize("1536x864")).toEqual({ width: 1536, height: 864 });
    expect(validateImageSize("2048x1024")).toEqual({ width: 2048, height: 1024 });
  });

  it("rejects malformed strings", () => {
    expect(() => validateImageSize("1024")).toThrow(ImageValidationError);
    expect(() => validateImageSize("1024 x 1024")).toThrow(ImageValidationError);
    expect(() => validateImageSize("foo")).toThrow(ImageValidationError);
    expect(() => validateImageSize("")).toThrow(ImageValidationError);
  });

  it("rejects non-positive dimensions", () => {
    expect(() => validateImageSize("0x1024")).toThrow(ImageValidationError);
    expect(() => validateImageSize("1024x0")).toThrow(ImageValidationError);
  });

  it("rejects dimensions not divisible by 16", () => {
    expect(() => validateImageSize("1023x1024")).toThrow(ImageValidationError);
    expect(() => validateImageSize("1024x1023")).toThrow(ImageValidationError);
    expect(() => validateImageSize("1000x1000")).toThrow(ImageValidationError);
  });

  it("rejects resolutions above the 3840x2160 ceiling", () => {
    expect(() => validateImageSize("3856x2160")).toThrow(ImageValidationError);
    expect(() => validateImageSize("3840x2176")).toThrow(ImageValidationError);
  });

  it("rejects aspect ratios outside 1:3..3:1", () => {
    // 4:1 aspect — too wide
    expect(() => validateImageSize("3840x960")).toThrow(ImageValidationError);
    // 1:4 aspect — too tall
    expect(() => validateImageSize("512x2048")).toThrow(ImageValidationError);
  });

  it("accepts boundary aspect ratios (1:3 and 3:1) within the dimension ceiling", () => {
    // 3:1 boundary against the 3840 width ceiling
    expect(validateImageSize("3840x1280")).toEqual({ width: 3840, height: 1280 });
    // 1:3 boundary against the 2160 height ceiling
    expect(validateImageSize("720x2160")).toEqual({ width: 720, height: 2160 });
  });
});

describe("validateBackgroundFormat", () => {
  it("accepts transparent + png", () => {
    expect(() => validateBackgroundFormat("transparent", "png")).not.toThrow();
  });

  it("accepts transparent + webp", () => {
    expect(() => validateBackgroundFormat("transparent", "webp")).not.toThrow();
  });

  it("rejects transparent + jpeg (no alpha channel)", () => {
    expect(() => validateBackgroundFormat("transparent", "jpeg")).toThrow(
      ImageValidationError
    );
  });

  it("accepts opaque or auto with any format", () => {
    expect(() => validateBackgroundFormat("opaque", "jpeg")).not.toThrow();
    expect(() => validateBackgroundFormat("auto", "jpeg")).not.toThrow();
    expect(() => validateBackgroundFormat("auto", undefined)).not.toThrow();
  });

  it("treats both fields undefined as valid (defaults apply)", () => {
    expect(() => validateBackgroundFormat(undefined, undefined)).not.toThrow();
  });
});

describe("ImageValidationError", () => {
  it("exposes structured fields for error handling", () => {
    try {
      validateImageSize("1023x1024");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ImageValidationError);
      const e = err as ImageValidationError;
      expect(e.field).toBe("size");
      expect(e.received).toBe("1023x1024");
      expect(e.expected).toContain("divisible");
    }
  });
});
