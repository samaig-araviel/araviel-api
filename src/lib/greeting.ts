/**
 * Greeting Interceptor — fast-path for pure greetings, social pleasantries, and identity questions.
 *
 * Detects messages that don't need AI routing and returns a canned response instantly,
 * saving both the ADE network call and the provider API call.
 *
 * Design principles:
 *  - Conservative: if in doubt, return null (let ADE handle it)
 *  - Toggleable: respects GREETING_INTERCEPT_ENABLED env var
 *  - Stateless: no side effects, pure classification + response generation
 *  - Single responsibility: detection is separate from response generation
 */

// ─── Feature flag ────────────────────────────────────────────────────────────

export function isGreetingInterceptEnabled(): boolean {
  const flag = process.env.GREETING_INTERCEPT_ENABLED;
  // Enabled by default; only disabled if explicitly set to "false" or "0"
  if (flag === "false" || flag === "0") return false;
  return true;
}

// ─── Detection ───────────────────────────────────────────────────────────────

const GREETING_PREFIXES =
  /^(h[ei]y?|hi+|hello|howdy|hola|sup|yo+|hiya|heya|good\s*(morning|afternoon|evening|night)|gm|g'?day|morning|evening|afternoon|greetings|salut|bonjour|namaste|what'?s\s*up|whats\s*up|wassup|whaddup)\b/i;

const SOCIAL_PLEASANTRIES =
  /^(how\s*(are|r)\s*(you|u|ya|things)(\s*(doing|going|today|this\s*(morning|afternoon|evening)))?[?!.]*|how'?s\s*(it\s*going|everything|life|things|your\s*day)[?!.]*|what'?s\s*(good|new|happening|going\s*on)[?!.]*|you\s*(good|ok(ay)?|alright)[?!.]*|i'?m\s*(back|here)[.!]*|thanks?\s*(for\s*(being\s*here|existing))?[.!]*)$/i;

const IDENTITY_PATTERNS =
  /^(what\s*(can|do)\s*you\s*do[?!.]*|who\s*(are|r)\s*(you|u)[?!.]*|what\s*(are|r)\s*(you|u)[?!.]*|what\s*is\s*arav[ei][ei]?l[?!.]*|tell\s*me\s*about\s*(yourself|you|arav[ei][ei]?l)[?!.]*|introduce\s*yourself[?!.]*|what('?s|\s*is)\s*this[?!.]*|help[?!.]*)$/i;

const FAREWELL_PATTERNS =
  /^(bye+|goodbye|good\s*night|gn|see\s*(you|ya|u)(\s*later|\s*soon|\s*tomorrow)?|later|take\s*care|peace|cheers|ciao|adios|night)[?!.]*$/i;

const THANKS_PATTERNS =
  /^(thanks?(\s*(you|u|so\s*much|a\s*(lot|bunch|million)))?|ty|cheers|much\s*appreciated|appreciate\s*(it|that))[?!.]*$/i;

/**
 * Strip a greeting prefix from the message and return what remains.
 * If the remainder is empty or a social pleasantry, it's a pure greeting.
 */
function stripGreetingPrefix(message: string): string {
  return message.replace(GREETING_PREFIXES, "").replace(/^[,!.\s]+/, "").trim();
}

export type GreetingCategory = "greeting" | "identity" | "farewell" | "thanks" | null;

/**
 * Classify a message. Returns the category if it's a pure greeting/identity/farewell/thanks,
 * or null if the message should go through normal ADE routing.
 *
 * The classifier is intentionally conservative:
 *  - Strips greeting prefix, checks if remainder is empty or a social pleasantry
 *  - Identity/farewell/thanks must match the FULL message (no trailing content)
 */
export function classifyGreeting(rawMessage: string): GreetingCategory {
  const message = rawMessage.trim();
  if (!message) return null;

  // Short-circuit: messages over 120 chars are almost never pure greetings
  if (message.length > 120) return null;

  // Identity questions (full-message match)
  if (IDENTITY_PATTERNS.test(message)) return "identity";

  // Farewell (full-message match)
  if (FAREWELL_PATTERNS.test(message)) return "farewell";

  // Thanks (full-message match)
  if (THANKS_PATTERNS.test(message)) return "thanks";

  // Social pleasantry without greeting prefix (full-message match)
  if (SOCIAL_PLEASANTRIES.test(message)) return "greeting";

  // Check if the message starts with a greeting
  if (GREETING_PREFIXES.test(message)) {
    const remainder = stripGreetingPrefix(message);

    // Pure greeting — nothing left
    if (!remainder) return "greeting";

    // Greeting + social pleasantry (e.g., "hi, how are you?")
    if (SOCIAL_PLEASANTRIES.test(remainder)) return "greeting";

    // Greeting + name reference (e.g., "hi araviel", "hello there")
    if (/^(arav[ei][ei]?l|there|everyone|all|friend|buddy|mate|world)[?!.]*$/i.test(remainder)) {
      return "greeting";
    }

    // Anything else after the greeting means it's a real prompt — pass through
    return null;
  }

  return null;
}

// ─── Response generation ─────────────────────────────────────────────────────

function getTimeOfDay(): "morning" | "afternoon" | "evening" {
  const hour = new Date().getUTCHours();
  // Approximate UK time (UTC+0/+1) — good enough for greeting context
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const GREETING_RESPONSES: Record<"morning" | "afternoon" | "evening", string[]> = {
  morning: [
    "Good morning! What can I help you with today?",
    "Morning! Ready to help whenever you are.",
    "Good morning! What would you like to work on?",
    "Hey, good morning! How can I assist you?",
    "Morning! I'm here and ready — what's on your mind?",
  ],
  afternoon: [
    "Good afternoon! What can I help you with?",
    "Hey there! How can I help this afternoon?",
    "Good afternoon! Ready when you are.",
    "Hi! What would you like to work on?",
    "Afternoon! I'm here to help — what do you need?",
  ],
  evening: [
    "Good evening! What can I help you with?",
    "Hey! How can I help you this evening?",
    "Good evening! What would you like to work on?",
    "Evening! I'm here and ready to help.",
    "Hi there! What can I do for you tonight?",
  ],
};

const GENERIC_GREETING_RESPONSES = [
  "Hey! How can I help you today?",
  "Hi there! What can I do for you?",
  "Hello! Ready to help — what's on your mind?",
  "Hey! What would you like to work on?",
  "Hi! I'm here to help. What do you need?",
  "Hello there! How can I assist you?",
  "Hey! What can I help you with?",
];

const IDENTITY_RESPONSES = [
  "I'm Araveil — an AI assistant that connects you to the best AI model for every task. I have access to models from OpenAI, Anthropic, Google, Meta, and more. The Araveil Decision Engine automatically picks the right one based on what you're asking. Just send me a message and I'll get you the best answer!",
  "I'm Araveil! I give you access to all major AI models — Claude, GPT, Gemini, Llama, and others — through one conversation. My routing engine analyses your message and picks the best model for the job. Try asking me anything: code, writing, research, analysis, image generation, and more.",
  "Hey! I'm Araveil, your AI assistant. What makes me different is that I don't rely on a single AI model — I have access to 40+ models across 6 providers, and I automatically route your message to the one that'll give the best answer. Ask me anything — coding, writing, research, creative work, you name it.",
];

const FAREWELL_RESPONSES = [
  "See you later! Come back any time.",
  "Bye! It was great chatting with you.",
  "Take care! I'll be here whenever you need me.",
  "Goodbye! Have a great one.",
  "See you! Don't hesitate to come back if you need anything.",
];

const THANKS_RESPONSES = [
  "You're welcome! Let me know if you need anything else.",
  "Happy to help! Anything else I can do?",
  "No problem at all! I'm here if you need me.",
  "Glad I could help! Feel free to ask anything else.",
  "You're welcome! That's what I'm here for.",
];

/**
 * Generate a greeting response for the given category.
 * Returns a random, contextual response string.
 */
export function generateGreetingResponse(category: GreetingCategory): string {
  switch (category) {
    case "greeting": {
      const timeOfDay = getTimeOfDay();
      // 60% time-of-day aware, 40% generic — keeps variety high
      if (Math.random() < 0.6) {
        return pickRandom(GREETING_RESPONSES[timeOfDay]);
      }
      return pickRandom(GENERIC_GREETING_RESPONSES);
    }
    case "identity":
      return pickRandom(IDENTITY_RESPONSES);
    case "farewell":
      return pickRandom(FAREWELL_RESPONSES);
    case "thanks":
      return pickRandom(THANKS_RESPONSES);
    default:
      return pickRandom(GENERIC_GREETING_RESPONSES);
  }
}

// ─── Synthetic model info for routing event ──────────────────────────────────

/** Model info object used in the routing SSE event for intercepted greetings. */
export const GREETING_MODEL_INFO = {
  id: "araveil-instant",
  name: "Araveil Instant",
  provider: "araveil",
  score: 1.0,
  reasoning: "Greeting detected — responded instantly without AI provider call.",
};

/** Synthetic ADE analysis for intercepted greetings. */
export function createGreetingAnalysis(category: GreetingCategory) {
  return {
    intent: "conversation",
    domain: "general",
    complexity: "trivial",
    tone: "friendly",
    modality: "text",
    keywords: [],
    humanContextUsed: false,
  };
}

/** Zero-cost token usage for intercepted greetings. */
export const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedTokens: 0,
};
