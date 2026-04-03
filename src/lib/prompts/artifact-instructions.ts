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

For complex visual content that cannot be expressed well with standard blocks (periodic tables, organizational charts, color-coded grids, custom infographics, dashboards, visual diagrams), you MUST emit a \`\`\`artifact code block containing self-contained HTML+CSS.

### When to use artifacts vs native blocks:
- Simple timeline (3-12 events): use \`\`\`timeline (simple or eras format)
- Comparison (2-4 items): use \`\`\`comparison
- Step-by-step guide: use \`\`\`steps
- Data chart (line/bar/pie/etc): use \`\`\`chart
- Diagrams & flowcharts: use \`\`\`mermaid
- Periodic table, org chart, custom grid, complex infographic, dashboard, visual reference: use \`\`\`artifact

IMPORTANT: When the user asks for a periodic table, org chart, seating chart, color-coded grid, or any complex visual reference, you MUST respond with a \`\`\`artifact code block. NEVER attempt these as markdown tables or plain text — they will look broken. See the examples below.

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

Example — periodic table (shows the first 10 elements; the full version MUST include all 118 elements following this exact same compact pattern, with correct grid-area positions for the standard periodic table layout including lanthanides in row 9 cols 3-17 and actinides in row 10 cols 3-17):
\`\`\`artifact
<style>
.pt{display:grid;grid-template-columns:repeat(18,1fr);gap:2px;font-family:system-ui,sans-serif}
.e{border-radius:4px;padding:4px 2px;text-align:center;cursor:default;transition:transform .15s;border-left:3px solid transparent;overflow:hidden}
.e:hover{transform:scale(1.1);z-index:1}
.e small{display:block;font-size:.5em;color:var(--text-muted)}
.e b{display:block;font-size:1em;color:var(--text-primary)}
.e::after{font-size:.45em;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}
.ak{background:rgba(239,68,68,.12);border-left-color:#e57373}
.ae{background:rgba(255,183,77,.12);border-left-color:#ffb74d}
.tm{background:rgba(100,181,246,.12);border-left-color:#64b5f6}
.pt2{background:rgba(149,117,205,.12);border-left-color:#9575cd}
.md{background:rgba(77,208,225,.12);border-left-color:#4dd0e1}
.nm{background:rgba(129,199,132,.12);border-left-color:#81c784}
.ha{background:rgba(186,104,200,.12);border-left-color:#ba68c8}
.ng{background:rgba(240,98,146,.12);border-left-color:#f06292}
.ln{background:rgba(77,182,172,.12);border-left-color:#4db6ac}
.ac{background:rgba(255,138,101,.12);border-left-color:#ff8a65}
.un{background:var(--bg-secondary);border-left-color:var(--border-color)}
.pth{color:var(--text-primary);margin:0 0 6px;font-size:1.1em}
.lg{display:flex;gap:10px;flex-wrap:wrap;margin:6px 0;font-size:.7em;color:var(--text-secondary)}
.lg span{display:flex;align-items:center;gap:3px}
.lg span::before{content:'';width:8px;height:8px;border-radius:2px}
.lg .c1::before{background:#e57373} .lg .c2::before{background:#ffb74d}
.lg .c3::before{background:#64b5f6} .lg .c4::before{background:#9575cd}
.lg .c5::before{background:#4dd0e1} .lg .c6::before{background:#81c784}
.lg .c7::before{background:#ba68c8} .lg .c8::before{background:#f06292}
.lg .c9::before{background:#4db6ac} .lg .c10::before{background:#ff8a65}
</style>
<h3 class="pth">Periodic Table of Elements</h3>
<div class="lg"><span class="c1">Alkali</span><span class="c2">Alkaline</span><span class="c3">Transition</span><span class="c4">Post-trans.</span><span class="c5">Metalloid</span><span class="c6">Nonmetal</span><span class="c7">Halogen</span><span class="c8">Noble gas</span><span class="c9">Lanthanide</span><span class="c10">Actinide</span></div>
<div class="pt">
<div class="e nm" style="grid-area:1/1"><small>1</small><b>H</b></div>
<div class="e ng" style="grid-area:1/18"><small>2</small><b>He</b></div>
<div class="e ak" style="grid-area:2/1"><small>3</small><b>Li</b></div>
<div class="e ae" style="grid-area:2/2"><small>4</small><b>Be</b></div>
<div class="e md" style="grid-area:2/13"><small>5</small><b>B</b></div>
<div class="e nm" style="grid-area:2/14"><small>6</small><b>C</b></div>
<div class="e nm" style="grid-area:2/15"><small>7</small><b>N</b></div>
<div class="e nm" style="grid-area:2/16"><small>8</small><b>O</b></div>
<div class="e ha" style="grid-area:2/17"><small>9</small><b>F</b></div>
<div class="e ng" style="grid-area:2/18"><small>10</small><b>Ne</b></div>
</div>
\`\`\`
Each element uses ~55 characters. For all 118 elements at this density, the total is approximately 8000 characters — well within the 10000 limit. Use this exact format for every element. Use grid-area:ROW/COL where rows 1-7 are the main periods, row 9 is lanthanides (cols 3-17), and row 10 is actinides (cols 3-17). Row 8 is an empty gap row.

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
- Use CSS Grid for table-like layouts (periodic table, calendars, org charts).
- Use flexbox for flowing layouts (timelines, card grids).
- Color-code categories with soft, muted rgba() backgrounds — they adapt naturally to light and dark themes.
- Add CSS :hover effects on interactive elements for a polished feel.
- Use border-radius for a modern look.
- Add subtle box-shadow for depth: box-shadow: 0 1px 3px rgba(0,0,0,0.08).
- For large artifacts with many elements, keep notation compact: short class names, grid-area shorthand, minimal whitespace.`;
}
