/**
 * Chart visualization instructions for AI providers.
 *
 * When included in the system prompt, these instructions teach AI models
 * to emit ```chart code blocks containing valid JSON that the frontend
 * renders as interactive charts (Recharts-based).
 *
 * The frontend parses these fenced blocks from the markdown response and
 * renders them inline — no special SSE event type is needed.
 */

const CHART_JSON_SCHEMA = `{
  "type": "line | area | bar | candlestick | pie | donut | composed | scatter",
  "title": "Chart Title",
  "subtitle": "Optional subtitle or description",
  "xKey": "name",
  "series": [
    { "key": "dataFieldName", "name": "Display Name", "color": "#d97706" }
  ],
  "config": {
    "yAxisFormat": "currency | inr | percent | compact | integer",
    "xAxisFormat": "date",
    "height": 360,
    "showGrid": true,
    "showLegend": true,
    "gradientFill": true,
    "referenceLines": [
      { "y": 150, "label": "Target", "color": "#10b981", "dashed": true }
    ]
  },
  "data": [
    { "name": "Jan", "price": 185.5, "volume": 1200000 }
  ]
}`;

const CHART_TYPE_GUIDE = [
  "line: Stock price trends, time series, performance over time.",
  "area: Portfolio performance, cumulative returns (uses gradient fills).",
  "bar: Earnings comparisons, revenue by quarter, volume, rankings.",
  "candlestick: OHLC stock/crypto data. Data must include open, high, low, close fields. Optionally volume.",
  "pie: Portfolio allocation, sector/market breakdown (data needs name and value fields).",
  "donut: Same as pie but with hollow center — use for cleaner look with fewer segments.",
  "composed: Multi-type overlay charts. Each series needs a chartType field (\"line\", \"bar\", or \"area\"). Use for volume bars + price line combos.",
  "scatter: Correlation analysis between two numeric variables.",
].join("\n");

const VALUE_FORMAT_OPTIONS = [
  "currency or usd: $1,234.56",
  "inr: ₹1,234.56",
  "percent or percentage: 12.34%",
  "compact: 1.2M, 3.4K",
  "integer: 1,234",
].join("\n");

const CHART_RULES = [
  "Always include real or representative data — never generate an empty chart.",
  "Use area with gradientFill: true as the default for single-series financial time data (stock prices, index performance).",
  "Use composed when showing price + volume together (volume as bar, price as line).",
  "Use candlestick only when you have or can construct OHLC data.",
  "Use donut over pie when there are 5 or fewer segments.",
  "Set xAxisFormat: \"date\" when the x-axis represents dates.",
  "Set yAxisFormat appropriately — currency for prices, percent for returns, compact for volume.",
  "Keep data arrays reasonable (10–60 data points for time series, 3–10 for categorical).",
  "Use reference lines for targets, averages, or thresholds (e.g., 52-week high/low, moving averages).",
  "You can include multiple charts in a single response by using multiple chart blocks.",
  "Always accompany the chart with brief text analysis — never show a chart alone without context.",
  "The chart renders inline in the message — present it naturally as part of your response.",
].join("\n");

const COLOR_SUGGESTIONS = [
  "Single series: #d97706 (warm amber — default).",
  "Gain/positive: #10b981 (emerald).",
  "Loss/negative: #ef4444 (red).",
  "Comparison pairs: #d97706 + #0ea5e9 (amber + sky blue).",
  "Multi-series: colors are auto-assigned if omitted.",
].join("\n");

/**
 * Returns the complete chart visualization instruction block for the system prompt.
 */
export function getChartInstructions(): string {
  return [
    "## Data Visualization",
    "",
    "When the user asks about financial data, stock analysis, comparisons, trends, portfolio allocation, or any question that would benefit from a visual chart, you MUST generate an inline chart using a ```chart code block containing valid JSON.",
    "",
    "### Chart JSON Schema",
    "",
    "```",
    CHART_JSON_SCHEMA,
    "```",
    "",
    "### Chart Type Guide",
    "",
    CHART_TYPE_GUIDE,
    "",
    "### Value Format Options",
    "",
    VALUE_FORMAT_OPTIONS,
    "",
    "### Rules",
    "",
    CHART_RULES,
    "",
    "### Color Suggestions",
    "",
    COLOR_SUGGESTIONS,
  ].join("\n");
}
