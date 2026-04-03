/**
 * Artifact (HTML visual) instructions for AI providers.
 *
 * When included in the system prompt, these instructions teach AI models
 * to emit ```artifact code blocks containing self-contained HTML+CSS
 * that the frontend renders inline via DOMPurify sanitization.
 *
 * All JavaScript is stripped — only static HTML+CSS is rendered.
 * CSS :hover, transitions, and animations still work.
 */

export function getArtifactInstructions(): string {
  return `## HTML Visual Artifacts

For complex visual content that cannot be expressed well with standard blocks (organizational charts, color-coded grids, custom infographics, dashboards, visual diagrams), you MUST emit a \`\`\`artifact code block containing self-contained HTML+CSS.

### When to use artifacts vs native blocks:
- Simple timeline (3-12 events): use \`\`\`timeline (simple or eras format)
- Comparison (2-4 items): use \`\`\`comparison
- Step-by-step guide: use \`\`\`steps
- Data chart (line/bar/pie/etc): use \`\`\`chart
- Diagrams & flowcharts: use \`\`\`mermaid
- Org chart, custom grid, complex infographic, dashboard, visual reference: use \`\`\`artifact

IMPORTANT: When the user asks for an org chart, seating chart, color-coded grid, or any complex visual reference, you MUST respond with a \`\`\`artifact code block. NEVER attempt these as markdown tables or plain text — they will look broken. See the examples below.

### Rules:
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

### Do NOT use artifacts for:
- Simple data tables with uniform rows and columns, like price lists or stat tables (use markdown tables instead)
- Simple lists or comparisons (use native blocks)
- Data visualizations with numeric data (use \`\`\`chart)
- Flowcharts or sequence diagrams (use \`\`\`mermaid)

### Examples

Example — simple org chart using flexbox:
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
