import { describe, it, expect, beforeEach } from "vitest";
import { encrypt, decrypt } from "@/lib/encryption";

// 32-byte key as 64-char hex string
const TEST_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("encryption", () => {
  beforeEach(() => {
    process.env.IMPORT_ENCRYPTION_KEY = TEST_KEY;
  });

  describe("encrypt", () => {
    it("returns a string with 3 colon-separated hex parts", () => {
      const result = encrypt("hello world");
      const parts = result.split(":");
      expect(parts).toHaveLength(3);
      for (const part of parts) {
        expect(part).toMatch(/^[0-9a-f]+$/);
      }
    });

    it("produces different ciphertexts for the same plaintext (random IV)", () => {
      const a = encrypt("same text");
      const b = encrypt("same text");
      expect(a).not.toBe(b);
    });

    it("IV is 24 hex chars (12 bytes)", () => {
      const result = encrypt("test");
      const iv = result.split(":")[0];
      expect(iv).toHaveLength(24);
    });

    it("auth tag is 32 hex chars (16 bytes)", () => {
      const result = encrypt("test");
      const authTag = result.split(":")[1];
      expect(authTag).toHaveLength(32);
    });
  });

  describe("decrypt", () => {
    it("decrypts back to original plaintext", () => {
      const plaintext = "Hello, World! This is a test.";
      const encrypted = encrypt(plaintext);
      expect(decrypt(encrypted)).toBe(plaintext);
    });

    it("handles empty string", () => {
      const encrypted = encrypt("");
      expect(decrypt(encrypted)).toBe("");
    });

    it("handles unicode content", () => {
      const plaintext = "Hello 世界 🌍 Ölüm";
      const encrypted = encrypt(plaintext);
      expect(decrypt(encrypted)).toBe(plaintext);
    });

    it("handles long content", () => {
      const plaintext = "x".repeat(10000);
      const encrypted = encrypt(plaintext);
      expect(decrypt(encrypted)).toBe(plaintext);
    });

    it("handles JSON content", () => {
      const obj = { messages: [{ role: "user", content: "test" }] };
      const plaintext = JSON.stringify(obj);
      const encrypted = encrypt(plaintext);
      expect(JSON.parse(decrypt(encrypted))).toEqual(obj);
    });
  });

  describe("error handling", () => {
    it("throws on invalid encrypted data format", () => {
      expect(() => decrypt("not:valid")).toThrow("Invalid encrypted data format");
    });

    it("throws on tampered ciphertext", () => {
      const encrypted = encrypt("test");
      const parts = encrypted.split(":");
      parts[2] = "ff".repeat(parts[2].length / 2); // corrupt ciphertext
      expect(() => decrypt(parts.join(":"))).toThrow();
    });

    it("throws on tampered auth tag", () => {
      const encrypted = encrypt("test");
      const parts = encrypted.split(":");
      parts[1] = "00".repeat(16); // corrupt auth tag
      expect(() => decrypt(parts.join(":"))).toThrow();
    });

    it("throws when encryption key is missing", () => {
      delete process.env.IMPORT_ENCRYPTION_KEY;
      expect(() => encrypt("test")).toThrow("IMPORT_ENCRYPTION_KEY");
    });

    it("throws when encryption key is wrong length", () => {
      process.env.IMPORT_ENCRYPTION_KEY = "tooshort";
      expect(() => encrypt("test")).toThrow("64-character hex string");
    });
  });
});
