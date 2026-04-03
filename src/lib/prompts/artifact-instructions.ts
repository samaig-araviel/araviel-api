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
- Keep HTML under 5000 characters.
- Prioritize: clear visual hierarchy, good color coding, readable typography, proper spacing.
- Use a clean, modern design aesthetic with rounded corners, subtle shadows, and good whitespace.

### Do NOT use artifacts for:
- Simple data tables with uniform rows and columns, like price lists or stat tables (use markdown tables instead)
- Simple lists or comparisons (use native blocks)
- Data visualizations with numeric data (use \`\`\`chart)
- Flowcharts or sequence diagrams (use \`\`\`mermaid)

### Examples

Example (mini periodic table — the full version should include all 118 elements with correct grid positions):
\`\`\`artifact
<style>
.ptable { display: grid; grid-template-columns: repeat(18, 1fr); gap: 3px; font-family: system-ui, sans-serif; }
.el { background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px; padding: 6px 2px; text-align: center; cursor: default; transition: transform 0.15s; }
.el:hover { transform: scale(1.08); z-index: 1; }
.el .num { font-size: 0.55em; color: var(--text-muted); }
.el .sym { font-size: 1em; font-weight: 700; color: var(--text-primary); }
.el .name { font-size: 0.5em; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nonmetal { border-left: 3px solid #10b981; }
.noble { border-left: 3px solid #8b5cf6; }
.alkali { border-left: 3px solid #ef4444; }
.alkaline { border-left: 3px solid #f59e0b; }
.metalloid { border-left: 3px solid #06b6d4; }
.ptitle { color: var(--text-primary); margin: 0 0 8px; font-size: 1.1em; }
.legend { display: flex; gap: 12px; flex-wrap: wrap; margin: 8px 0; font-size: 0.75em; color: var(--text-secondary); }
.legend span { display: flex; align-items: center; gap: 4px; }
.legend span::before { content: ''; width: 10px; height: 10px; border-radius: 2px; }
.legend .l-nm::before { background: #10b981; }
.legend .l-ng::before { background: #8b5cf6; }
.legend .l-ak::before { background: #ef4444; }
.legend .l-ae::before { background: #f59e0b; }
.legend .l-ml::before { background: #06b6d4; }
</style>
<h3 class="ptitle">Periodic Table</h3>
<div class="legend"><span class="l-ak">Alkali</span><span class="l-ae">Alkaline</span><span class="l-nm">Nonmetal</span><span class="l-ml">Metalloid</span><span class="l-ng">Noble gas</span></div>
<div class="ptable">
  <div class="el nonmetal" style="grid-column:1"><div class="num">1</div><div class="sym">H</div><div class="name">Hydrogen</div></div>
  <div class="el noble" style="grid-column:18"><div class="num">2</div><div class="sym">He</div><div class="name">Helium</div></div>
  <div class="el alkali" style="grid-column:1"><div class="num">3</div><div class="sym">Li</div><div class="name">Lithium</div></div>
  <div class="el alkaline" style="grid-column:2"><div class="num">4</div><div class="sym">Be</div><div class="name">Beryllium</div></div>
  <div class="el metalloid" style="grid-column:13"><div class="num">5</div><div class="sym">B</div><div class="name">Boron</div></div>
  <div class="el nonmetal" style="grid-column:14"><div class="num">6</div><div class="sym">C</div><div class="name">Carbon</div></div>
  <div class="el nonmetal" style="grid-column:15"><div class="num">7</div><div class="sym">N</div><div class="name">Nitrogen</div></div>
  <div class="el nonmetal" style="grid-column:16"><div class="num">8</div><div class="sym">O</div><div class="name">Oxygen</div></div>
  <div class="el nonmetal" style="grid-column:17"><div class="num">9</div><div class="sym">F</div><div class="name">Fluorine</div></div>
  <div class="el noble" style="grid-column:18"><div class="num">10</div><div class="sym">Ne</div><div class="name">Neon</div></div>
</div>
\`\`\`

Example (simple org chart using flexbox):
\`\`\`artifact
<style>
.org { display: flex; flex-direction: column; align-items: center; gap: 0; font-family: system-ui, sans-serif; }
.card { background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 10px; padding: 12px 20px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.08); transition: box-shadow 0.15s; }
.card:hover { box-shadow: 0 3px 8px rgba(0,0,0,0.12); }
.card .person { font-weight: 700; color: var(--text-primary); }
.card .role { font-size: 0.8em; color: var(--text-muted); margin-top: 2px; }
.vline { width: 2px; height: 18px; background: var(--border-color); }
.row { display: flex; gap: 24px; position: relative; }
.row::before { content: ''; position: absolute; top: 0; left: 25%; right: 25%; height: 2px; background: var(--border-color); }
.branch { display: flex; flex-direction: column; align-items: center; }
.branch .vline:first-child { height: 18px; }
</style>
<div class="org">
  <div class="card"><div class="person">Alice Chen</div><div class="role">CEO</div></div>
  <div class="vline"></div>
  <div class="row">
    <div class="branch"><div class="vline"></div><div class="card"><div class="person">Bob Park</div><div class="role">CTO</div></div></div>
    <div class="branch"><div class="vline"></div><div class="card"><div class="person">Carol Diaz</div><div class="role">CFO</div></div></div>
  </div>
</div>
\`\`\`

### Tips for great artifacts:
- Use CSS Grid for table-like layouts (periodic table, calendars, org charts).
- Use flexbox for flowing layouts (timelines, card grids).
- Color-code categories with distinct, accessible colors.
- Add CSS :hover effects on interactive elements for a polished feel.
- Use border-radius: 8px+ for a modern card look.
- Add subtle box-shadow for depth: box-shadow: 0 1px 3px rgba(0,0,0,0.1).`;
}
