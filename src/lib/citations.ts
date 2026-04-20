import type { Citation } from "@/lib/types";

/**
 * Normalizes a citation URL for duplicate detection.
 *
 * Strips protocol, a leading "www.", trailing slashes, the URL fragment, and
 * lowercases the host. Query strings are kept because different queries
 * genuinely point at different pages (e.g. YouTube video ids). Returns the
 * original string when parsing fails so non-URL identifiers still compare
 * correctly.
 */
export function normalizeCitationUrl(raw: string): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    const host = url.host.replace(/^www\./, "").toLowerCase();
    const path = url.pathname.replace(/\/+$/, "");
    return `${host}${path}${url.search}`;
  } catch {
    return trimmed;
  }
}

/**
 * Returns a new array containing the first occurrence of each citation,
 * deduplicated by normalized URL. Order is preserved. When duplicates are
 * merged, the richer record wins — a later entry with a non-empty snippet or a
 * more descriptive title upgrades the kept record in-place.
 *
 * @example
 *   dedupeCitations([
 *     { url: "https://example.com/a", title: "A" },
 *     { url: "https://www.example.com/a/", title: "A", snippet: "more" },
 *   ]);
 *   // → [{ url: "https://example.com/a", title: "A", snippet: "more" }]
 */
export function dedupeCitations(citations: readonly Citation[]): Citation[] {
  const byKey = new Map<string, Citation>();
  for (const c of citations) {
    if (!c || typeof c.url !== "string" || c.url.length === 0) continue;
    const key = normalizeCitationUrl(c.url);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...c });
      continue;
    }
    // Merge: prefer a non-empty snippet and a non-URL-fallback title.
    if (!existing.snippet && c.snippet) {
      existing.snippet = c.snippet;
    }
    if (
      (!existing.title || existing.title === existing.url) &&
      c.title &&
      c.title !== c.url
    ) {
      existing.title = c.title;
    }
  }
  return Array.from(byKey.values());
}
