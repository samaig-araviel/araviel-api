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

For complex visual content that cannot be expressed well with standard blocks (periodic tables, organizational charts, color-coded grids, custom infographics, dashboards, visual diagrams), you may emit a \`\`\`artifact code block containing self-contained HTML+CSS.

### When to use artifacts vs native blocks:
- Simple timeline (3-12 events): use \`\`\`timeline (simple or eras format)
- Comparison (2-4 items): use \`\`\`comparison
- Step-by-step guide: use \`\`\`steps
- Data chart (line/bar/pie/etc): use \`\`\`chart
- Diagrams & flowcharts: use \`\`\`mermaid
- Periodic table, org chart, custom grid, complex infographic, dashboard, visual reference: use \`\`\`artifact

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
- Simple data tables with rows and columns (use markdown tables instead)
- Simple lists or comparisons (use native blocks)
- Data visualizations with numeric data (use \`\`\`chart)
- Flowcharts or sequence diagrams (use \`\`\`mermaid)

IMPORTANT: Complex reference visuals like periodic tables, org charts, seating charts, and color-coded grids MUST use \`\`\`artifact — do NOT attempt these as markdown tables. They require CSS Grid layouts and color coding that markdown cannot express.

### Tips for great artifacts:
- Use CSS Grid for table-like layouts (periodic table, calendars, org charts).
- Use flexbox for flowing layouts (timelines, card grids).
- Color-code categories with distinct, accessible colors.
- Add CSS :hover effects on interactive elements for a polished feel.
- Use border-radius: 8px+ for a modern card look.
- Add subtle box-shadow for depth: box-shadow: 0 1px 3px rgba(0,0,0,0.1).

Note: If you are not confident in generating well-structured, visually polished HTML+CSS, prefer using the native block types (timeline, comparison, steps, chart) instead.`;
}
