/**
 * Streaming parser that extracts <think>...</think> tags from content chunks.
 *
 * Used by providers (e.g. Perplexity) that embed thinking/reasoning inline
 * in their response content rather than emitting separate thinking events.
 *
 * The parser is a simple state machine with four states:
 *   CONTENT        — normal text, emitted as "delta"
 *   TAG_MAYBE_OPEN — saw a potential `<think>` opening, buffering to confirm
 *   THINKING       — inside a <think> block, emitted as "thinking"
 *   TAG_MAYBE_CLOSE— inside thinking, saw a potential `</think>` closing
 *
 * Safe to run on any provider — if no <think> tags are present, all content
 * passes through unchanged as "delta" events with zero overhead.
 */

export interface ParsedChunk {
  type: "delta" | "thinking";
  content: string;
}

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

const enum State {
  CONTENT,
  TAG_MAYBE_OPEN,
  THINKING,
  TAG_MAYBE_CLOSE,
}

export class ThinkTagParser {
  private state: State = State.CONTENT;
  private buffer = "";

  /**
   * Feed a raw content chunk from the provider stream.
   * Returns zero or more parsed chunks to yield downstream.
   */
  push(chunk: string): ParsedChunk[] {
    const results: ParsedChunk[] = [];
    let pending = "";

    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];

      switch (this.state) {
        case State.CONTENT:
          if (ch === "<") {
            this.state = State.TAG_MAYBE_OPEN;
            this.buffer = "<";
          } else {
            pending += ch;
          }
          break;

        case State.TAG_MAYBE_OPEN:
          this.buffer += ch;
          if (OPEN_TAG.startsWith(this.buffer)) {
            if (this.buffer === OPEN_TAG) {
              // Confirmed <think> — flush any pending content as delta
              if (pending) {
                results.push({ type: "delta", content: pending });
                pending = "";
              }
              this.state = State.THINKING;
              this.buffer = "";
            }
            // else keep buffering — partial match
          } else {
            // Not a <think> tag — flush buffer as normal content
            pending += this.buffer;
            this.buffer = "";
            this.state = State.CONTENT;
          }
          break;

        case State.THINKING:
          if (ch === "<") {
            this.state = State.TAG_MAYBE_CLOSE;
            this.buffer = "<";
          } else {
            pending += ch;
          }
          break;

        case State.TAG_MAYBE_CLOSE:
          this.buffer += ch;
          if (CLOSE_TAG.startsWith(this.buffer)) {
            if (this.buffer === CLOSE_TAG) {
              // Confirmed </think> — flush pending as thinking
              if (pending) {
                results.push({ type: "thinking", content: pending });
                pending = "";
              }
              this.state = State.CONTENT;
              this.buffer = "";
            }
            // else keep buffering — partial match
          } else {
            // Not a </think> tag — flush buffer as thinking content
            pending += this.buffer;
            this.buffer = "";
            this.state = State.THINKING;
          }
          break;
      }
    }

    // Flush any pending content accumulated during this chunk
    if (pending) {
      const type = this.state === State.THINKING || this.state === State.TAG_MAYBE_CLOSE
        ? "thinking"
        : "delta";
      results.push({ type, content: pending });
    }

    return results;
  }

  /**
   * Call when the stream ends to flush any remaining buffered content.
   */
  flush(): ParsedChunk[] {
    const results: ParsedChunk[] = [];

    if (this.buffer) {
      const type = this.state === State.TAG_MAYBE_CLOSE || this.state === State.THINKING
        ? "thinking"
        : "delta";
      results.push({ type, content: this.buffer });
      this.buffer = "";
    }

    this.state = State.CONTENT;
    return results;
  }
}
