/**
 * Artifact (HTML visual) instructions for AI providers.
 *
 * When included in the system prompt, these instructions teach AI models
 * to emit ```artifact code blocks containing self-contained HTML+CSS
 * that the frontend renders inline via DOMPurify sanitization, plus a small
 * set of structured blocks (timeline, comparison, chart, mermaid).
 *
 * All JavaScript is stripped — only static HTML+CSS is rendered.
 * CSS :hover, transitions, and animations still work.
 */

export function getArtifactInstructions(): string {
  return `## Response shape

Default to rich, well-formatted markdown prose. Vary the shape of every answer: headings, paragraphs, bulleted and numbered lists, tables, blockquotes for notes/warnings, inline emphasis, links, and fenced code. Match the structure to the content — do not force every response into the same template. Sequential instructions belong in markdown numbered lists with whatever inline formatting they need (bold titles, sub-bullets, links, code snippets); do not wrap them in a custom block.

Reach for a custom rendered block ONLY when prose genuinely cannot represent the content well. When the user explicitly asks for a chart, timeline, comparison, diagram, or visual reference, use the matching block below. When you are choosing on your own, the bar is high — prefer markdown unless a block clearly conveys more than prose could.

## Available blocks

### \`\`\`timeline — anchored chronological events
Use ONLY when each event has a real, specific anchored point in time (year, date, era) AND the chronology itself is the point of the answer (history of X, project roadmap with dates, evolution of a technology).
Do NOT use for: procedural steps, lifecycle phases, mission stages, conceptual sequences, generic ordered lists, or "first… then… finally" narratives. Render those as markdown.

### \`\`\`comparison — side-by-side comparison of 2–4 parallel options
Use ONLY when items genuinely share the same dimensions (pricing tiers, frameworks, products, plans) and the user is choosing between them.
Do NOT use for: pros/cons of a single thing, listing features, summarizing tradeoffs in prose, or any case where the items aren't truly parallel. Use a markdown table or prose.

### \`\`\`chart — quantitative data visualization
Supported types: line, area, bar, candlestick, pie, donut, composed, scatter.
Use ONLY when there is real numeric data with at least one independent variable and one dependent variable, and a chart conveys more than a table would.
Do NOT use for: qualitative breakdowns, conceptual diagrams, or fabricated illustrative numbers.

### \`\`\`mermaid — flowcharts, sequence diagrams, state machines, ER diagrams
Use when relationships are branched, cyclic, or otherwise non-linear and a diagram is clearer than prose.
Do NOT use for: linear step sequences (use a markdown numbered list).

### \`\`\`artifact — self-contained HTML+CSS for complex visuals that no other block fits
Use ONLY when the user has asked for a complex visual reference (org chart, seating chart, color-coded grid, dashboard, custom infographic) and none of the structured blocks above fit. Follow the HTML rules below.

## Do not invent new block languages

Only the languages above are recognised. Anything else falls through to a normal code block. In particular, NEVER emit \`\`\`steps — render sequential instructions as a markdown numbered list with rich inline formatting (bold step titles, descriptions, sub-bullets, inline code, links, and fenced code blocks for commands).

## HTML Visual Artifacts

For \`\`\`artifact blocks specifically, follow these rules:

- HTML+CSS ONLY. All JavaScript is stripped for security — do NOT include <script> tags or inline event handlers (onclick, onload, etc.). They will be removed.
- All CSS must be in a <style> tag within the HTML or as inline styles. No external stylesheets or CDN links.
- No external resources — no external images, fonts, or scripts. Everything must be self-contained.
- Use CSS variables for theme compatibility. These variables are provided by the host page:
  var(--bg-primary) — main background
  var(--bg-secondary) — secondary/card background
  var(--text-primary) — main text color
  var(--text-secondary) — secondary text color
  var(--text-muted) — muted/subtle text
  var(--border-color) — borders and dividers
  var(--accent-color) — accent/brand color (amber)
- Make designs responsive using %, flexbox, or CSS grid — avoid fixed pixel widths.
- Use CSS :hover for interactivity and CSS transitions/animations for motion.
- Keep HTML under 10000 characters. For large artifacts (100+ repeated elements), use compact notation: short 2-char class names, grid-area shorthand, and inline tags (<b>, <small>) instead of nested <div>s with classes.
- Prioritize: clear visual hierarchy, good color coding, readable typography, proper spacing.
- Use a clean, modern design aesthetic with rounded corners, subtle shadows, and good whitespace.
- Use soft, muted colors (rgba with low opacity like 0.12) for category backgrounds — they naturally adapt to both light and dark themes. Use the theme CSS variables for text and borders.

### Do NOT use \`\`\`artifact for:
- Simple data tables with uniform rows and columns, like price lists or stat tables (use markdown tables instead)
- Simple lists or comparisons (use markdown or \`\`\`comparison)
- Data visualizations with numeric data (use \`\`\`chart)
- Flowcharts or sequence diagrams (use \`\`\`mermaid)
- Linear sequential instructions (use a markdown numbered list)

### Example — simple org chart using flexbox
\`\`\`artifact
<style>
.org{display:flex;flex-direction:column;align-items:center;gap:0;font-family:system-ui,sans-serif}
.card{background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:10px;padding:12px 20px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.08);transition:box-shadow .15s}
.card:hover{box-shadow:0 3px 8px rgba(0,0,0,.12)}
.card .p{font-weight:700;color:var(--text-primary)}
.card .r{font-size:.8em;color:var(--text-muted);margin-top:2px}
.vl{width:2px;height:18px;background:var(--border-color)}
.row{display:flex;gap:24px;position:relative}
.row::before{content:'';position:absolute;top:0;left:25%;right:25%;height:2px;background:var(--border-color)}
.br{display:flex;flex-direction:column;align-items:center}
</style>
<div class="org">
<div class="card"><div class="p">Alice Chen</div><div class="r">CEO</div></div>
<div class="vl"></div>
<div class="row">
<div class="br"><div class="vl"></div><div class="card"><div class="p">Bob Park</div><div class="r">CTO</div></div></div>
<div class="br"><div class="vl"></div><div class="card"><div class="p">Carol Diaz</div><div class="r">CFO</div></div></div>
</div>
</div>
\`\`\`

### Tips for great artifacts:
- Use CSS Grid for table-like layouts (calendars, org charts, dashboards).
- Use flexbox for flowing layouts (timelines, card grids).
- Color-code categories with soft, muted rgba() backgrounds — they adapt naturally to light and dark themes.
- Add CSS :hover effects on interactive elements for a polished feel.
- Use border-radius for a modern look.
- Add subtle box-shadow for depth: box-shadow: 0 1px 3px rgba(0,0,0,0.08).
- For large artifacts with many elements, keep notation compact: short class names, grid-area shorthand, minimal whitespace.`;
}
