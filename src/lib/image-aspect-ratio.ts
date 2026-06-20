/**
 * Aspect ratios our image-generation pipeline supports. These map cleanly
 * onto both Gemini's `imageConfig.aspectRatio` enum and OpenAI's gpt-image-2
 * `size` grid (see `aspectRatioToOpenAISize`).
 */
export type ImageAspectRatio =
  | "1:1"
  | "16:9"
  | "9:16"
  | "4:3"
  | "3:4"
  | "21:9"
  | "9:21";

/**
 * Explicit ratio notation (e.g. "4:3", "9 × 16") and exact pixel dimensions
 * (e.g. "1920×1080"). Checked first — when the user says "4:3", that beats
 * a stray "landscape" elsewhere in the prompt.
 */
const EXPLICIT_PATTERNS: ReadonlyArray<{ ratio: ImageAspectRatio; rx: RegExp }> = [
  { ratio: "9:21", rx: /\b9\s*[:×x]\s*21\b/i },
  { ratio: "21:9", rx: /\b21\s*[:×x]\s*9\b/i },
  { ratio: "9:16", rx: /\b9\s*[:×x]\s*16\b/i },
  { ratio: "16:9", rx: /\b16\s*[:×x]\s*9\b/i },
  { ratio: "3:4", rx: /\b3\s*[:×x]\s*4\b/i },
  { ratio: "4:3", rx: /\b4\s*[:×x]\s*3\b/i },
  { ratio: "1:1", rx: /\b1\s*[:×x]\s*1\b/i },
  // Pixel dimensions matching our canonical sizes
  { ratio: "9:21", rx: /\b768\s*[×x*]\s*1792\b/i },
  { ratio: "21:9", rx: /\b1792\s*[×x*]\s*768\b/i },
  { ratio: "9:16", rx: /\b(?:1080|864)\s*[×x*]\s*(?:1920|1536)\b/i },
  { ratio: "16:9", rx: /\b(?:1920|1536)\s*[×x*]\s*(?:1080|864)\b/i },
  { ratio: "3:4", rx: /\b960\s*[×x*]\s*1280\b/i },
  { ratio: "4:3", rx: /\b1280\s*[×x*]\s*960\b/i },
  { ratio: "1:1", rx: /\b1024\s*[×x*]\s*1024\b/i },
];

/**
 * Keyword patterns — used only when no explicit ratio is found. Ordered so
 * more specific phrases (e.g. "vertical banner" for 9:21) win over the
 * looser cues ("vertical" for 9:16).
 */
const KEYWORD_PATTERNS: ReadonlyArray<{ ratio: ImageAspectRatio; rx: RegExp }> = [
  { ratio: "9:21", rx: /\bextra[-\s]?tall\b/i },
  { ratio: "9:21", rx: /\bvertical\s+banner\b/i },
  { ratio: "21:9", rx: /\b(?:ultrawide|cinematic)\b/i },
  { ratio: "9:16", rx: /\binstagram\s+(?:stor(?:y|ies)|reel)\b/i },
  { ratio: "9:16", rx: /\b(?:tiktok|reels?|shorts?)\b/i },
  { ratio: "9:16", rx: /\bphone\s+wallpaper\b/i },
  { ratio: "9:16", rx: /\b(?:portrait|vertical)\b/i },
  { ratio: "16:9", rx: /\b(?:landscape|widescreen|horizontal)\b/i },
  { ratio: "16:9", rx: /\bdesktop\s+wallpaper\b/i },
  { ratio: "16:9", rx: /\byoutube\s+(?:thumbnail|banner)\b/i },
  { ratio: "1:1", rx: /\b(?:square|instagram\s+post|profile\s+picture)\b/i },
];

/**
 * Detect the aspect ratio requested by an image-generation prompt. Returns
 * `1:1` when no orientation cue is found — matching the default behaviour of
 * every image API we call.
 *
 * Two-pass scan: explicit ratio notation ("4:3", "1920×1080") wins over
 * keyword cues ("landscape", "portrait"). Within each pass, more specific
 * patterns are checked before the looser ones.
 *
 * Deterministic, dependency-free, runs in microseconds. Replaces the older
 * gpt-4o-mini synthesis step which both rewrote the prompt (losing user
 * intent) and added 1-2 seconds of latency per image.
 */
export function detectImageAspectRatio(prompt: string): ImageAspectRatio {
  if (!prompt) return "1:1";

  for (const { ratio, rx } of EXPLICIT_PATTERNS) {
    if (rx.test(prompt)) return ratio;
  }
  for (const { ratio, rx } of KEYWORD_PATTERNS) {
    if (rx.test(prompt)) return ratio;
  }

  return "1:1";
}
