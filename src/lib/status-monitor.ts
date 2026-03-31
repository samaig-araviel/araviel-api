import { getSupabase } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ProviderName =
  | "anthropic"
  | "openai"
  | "google"
  | "perplexity"
  | "xai"
  | "elevenlabs";

type ProviderStatus =
  | "operational"
  | "degraded"
  | "partial_outage"
  | "major_outage"
  | "unknown";

type PlatformService = "arc" | "ade" | "supabase";
type PlatformStatus = "operational" | "degraded" | "down" | "unknown";

interface StatusPageResult {
  status: ProviderStatus;
  raw: string | null;
  components: Record<string, string>[] | null;
  incidents: Record<string, unknown>[] | null;
}

interface HealthCheckResult {
  ok: boolean;
  latencyMs: number;
  error: string | null;
}

interface UsageMetrics {
  successRate: number | null;
  errorRate: number | null;
  avgResponseMs: number | null;
}

interface ProviderCheckResult {
  provider: ProviderName;
  status: ProviderStatus;
  source: "reconciled";
  statusPageRaw: string | null;
  healthCheckOk: boolean;
  latencyMs: number | null;
  errorMessage: string | null;
  components: Record<string, string>[] | null;
  incidents: Record<string, unknown>[] | null;
  successRate: number | null;
  errorRate: number | null;
  avgResponseMs: number | null;
}

interface PlatformCheckResult {
  service: PlatformService;
  status: PlatformStatus;
  latencyMs: number | null;
  errorMessage: string | null;
  metadata: Record<string, unknown> | null;
}

export interface StatusCheckResult {
  providers: ProviderCheckResult[];
  platform: PlatformCheckResult[];
  overall: ProviderStatus;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------

const PROVIDER_STATUS_CONFIG: Record<
  ProviderName,
  {
    statusPageUrl: string | null;
    statusPageType: "atlassian" | "incidentio" | "instatus" | "google_cloud" | null;
    componentNames: string[];
    healthCheckUrl: string;
    healthCheckMethod: "GET" | "POST";
    healthCheckBody: Record<string, unknown> | null;
    healthCheckApiKeyEnv: string;
    healthCheckAuthHeader: "Authorization" | "x-api-key";
    healthCheckAuthPrefix: string;
  }
> = {
  anthropic: {
    statusPageUrl: "https://status.claude.com",
    statusPageType: "atlassian",
    componentNames: ["Claude API"],
    healthCheckUrl: "https://api.anthropic.com/v1/messages",
    healthCheckMethod: "POST",
    healthCheckBody: {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    },
    healthCheckApiKeyEnv: "ANTHROPIC_API_KEY",
    healthCheckAuthHeader: "x-api-key",
    healthCheckAuthPrefix: "",
  },
  openai: {
    statusPageUrl: "https://status.openai.com",
    statusPageType: "incidentio",
    componentNames: ["Chat Completions", "Responses"],
    healthCheckUrl: "https://api.openai.com/v1/models",
    healthCheckMethod: "GET",
    healthCheckBody: null,
    healthCheckApiKeyEnv: "OPENAI_API_KEY",
    healthCheckAuthHeader: "Authorization",
    healthCheckAuthPrefix: "Bearer ",
  },
  google: {
    statusPageUrl: "https://status.cloud.google.com",
    statusPageType: "google_cloud",
    componentNames: ["Vertex Gemini API"],
    healthCheckUrl:
      "https://generativelanguage.googleapis.com/v1beta/models?key=__KEY__",
    healthCheckMethod: "GET",
    healthCheckBody: null,
    healthCheckApiKeyEnv: "GOOGLE_API_KEY",
    healthCheckAuthHeader: "Authorization",
    healthCheckAuthPrefix: "",
  },
  perplexity: {
    statusPageUrl: "https://status.perplexity.com",
    statusPageType: "instatus",
    componentNames: ["API"],
    healthCheckUrl: "https://api.perplexity.ai/chat/completions",
    healthCheckMethod: "POST",
    healthCheckBody: {
      model: "sonar",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    },
    healthCheckApiKeyEnv: "PERPLEXITY_API_KEY",
    healthCheckAuthHeader: "Authorization",
    healthCheckAuthPrefix: "Bearer ",
  },
  xai: {
    statusPageUrl: null,
    statusPageType: null,
    componentNames: [],
    healthCheckUrl: "https://api.x.ai/v1/models",
    healthCheckMethod: "GET",
    healthCheckBody: null,
    healthCheckApiKeyEnv: "XAI_API_KEY",
    healthCheckAuthHeader: "Authorization",
    healthCheckAuthPrefix: "Bearer ",
  },
  elevenlabs: {
    statusPageUrl: "https://status.elevenlabs.io",
    statusPageType: "incidentio",
    componentNames: ["Text to Speech"],
    healthCheckUrl: "https://api.elevenlabs.io/v1/models",
    healthCheckMethod: "GET",
    healthCheckBody: null,
    healthCheckApiKeyEnv: "ELEVENLABS_API_KEY",
    healthCheckAuthHeader: "Authorization",
    healthCheckAuthPrefix: "",
  },
};

const ALL_PROVIDERS: ProviderName[] = [
  "anthropic",
  "openai",
  "google",
  "perplexity",
  "xai",
  "elevenlabs",
];

// ---------------------------------------------------------------------------
// Status page pollers
// ---------------------------------------------------------------------------

function mapAtlassianStatus(raw: string): ProviderStatus {
  switch (raw) {
    case "operational":
      return "operational";
    case "degraded_performance":
      return "degraded";
    case "partial_outage":
      return "partial_outage";
    case "major_outage":
      return "major_outage";
    default:
      return "unknown";
  }
}

function mapInstatusStatus(raw: string): ProviderStatus {
  const upper = raw.toUpperCase();
  if (upper === "OPERATIONAL") return "operational";
  if (upper === "DEGRADEDPERFORMANCE") return "degraded";
  if (upper === "PARTIALOUTAGE") return "partial_outage";
  if (upper === "MAJOROUTAGE" || upper === "UNDERMAINTENANCE")
    return "major_outage";
  return "unknown";
}

async function fetchJson(url: string, timeoutMs = 10000): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function pollAtlassianStatuspage(
  baseUrl: string,
  componentNames: string[]
): Promise<StatusPageResult> {
  const data = (await fetchJson(`${baseUrl}/api/v2/summary.json`)) as {
    components?: { name: string; status: string }[];
    incidents?: Record<string, unknown>[];
  };

  const components =
    data.components?.map((c) => ({ name: c.name, status: c.status })) ?? [];

  const matched = components.filter((c) =>
    componentNames.some((n) => c.name.toLowerCase().includes(n.toLowerCase()))
  );

  let worstStatus: ProviderStatus = "operational";
  let worstRaw = "operational";

  for (const comp of matched) {
    const mapped = mapAtlassianStatus(comp.status);
    if (statusSeverity(mapped) > statusSeverity(worstStatus)) {
      worstStatus = mapped;
      worstRaw = comp.status;
    }
  }

  return {
    status: matched.length > 0 ? worstStatus : "unknown",
    raw: worstRaw,
    components,
    incidents: (data.incidents as Record<string, unknown>[]) ?? null,
  };
}

async function pollIncidentIO(
  baseUrl: string,
  componentNames: string[]
): Promise<StatusPageResult> {
  const data = (await fetchJson(`${baseUrl}/api/v2/components.json`)) as {
    components?: { name: string; status: string }[];
  };

  const components =
    data.components?.map((c) => ({ name: c.name, status: c.status })) ?? [];

  const matched = components.filter((c) =>
    componentNames.some((n) => c.name.toLowerCase().includes(n.toLowerCase()))
  );

  let worstStatus: ProviderStatus = "operational";
  let worstRaw = "operational";

  for (const comp of matched) {
    const mapped = mapAtlassianStatus(comp.status);
    if (statusSeverity(mapped) > statusSeverity(worstStatus)) {
      worstStatus = mapped;
      worstRaw = comp.status;
    }
  }

  return {
    status: matched.length > 0 ? worstStatus : "unknown",
    raw: worstRaw,
    components,
    incidents: null,
  };
}

async function pollInstatus(
  baseUrl: string,
  componentNames: string[]
): Promise<StatusPageResult> {
  const data = (await fetchJson(`${baseUrl}/v2/components.json`)) as {
    components?: { name: string; status: string }[];
  };

  const components =
    data.components?.map((c) => ({ name: c.name, status: c.status })) ?? [];

  const matched = components.filter((c) =>
    componentNames.some((n) => c.name.toLowerCase().includes(n.toLowerCase()))
  );

  let worstStatus: ProviderStatus = "operational";
  let worstRaw = "OPERATIONAL";

  for (const comp of matched) {
    const mapped = mapInstatusStatus(comp.status);
    if (statusSeverity(mapped) > statusSeverity(worstStatus)) {
      worstStatus = mapped;
      worstRaw = comp.status;
    }
  }

  return {
    status: matched.length > 0 ? worstStatus : "unknown",
    raw: worstRaw,
    components,
    incidents: null,
  };
}

async function pollGoogleCloudStatus(
  componentNames: string[]
): Promise<StatusPageResult> {
  const [productsData, incidentsData] = await Promise.all([
    fetchJson("https://status.cloud.google.com/products.json") as Promise<
      { id: string; name: string }[]
    >,
    fetchJson("https://status.cloud.google.com/incidents.json") as Promise<
      {
        service_name?: string;
        most_recent_update?: { status?: string };
        end?: string;
      }[]
    >,
  ]);

  const matchedProducts = (productsData ?? []).filter((p) =>
    componentNames.some((n) =>
      p.name?.toLowerCase().includes(n.toLowerCase())
    )
  );

  const activeIncidents = (incidentsData ?? []).filter((inc) => {
    if (inc.end) return false;
    return componentNames.some((n) =>
      inc.service_name?.toLowerCase().includes(n.toLowerCase())
    );
  });

  let status: ProviderStatus = "operational";
  if (activeIncidents.length > 0) {
    const hasOutage = activeIncidents.some((inc) => {
      const s = inc.most_recent_update?.status?.toLowerCase() ?? "";
      return s.includes("outage") || s.includes("disruption");
    });
    status = hasOutage ? "major_outage" : "degraded";
  }

  return {
    status: matchedProducts.length > 0 ? status : "unknown",
    raw: activeIncidents.length > 0 ? "incident_active" : "operational",
    components: matchedProducts.map((p) => ({ name: p.name, status: "listed" })),
    incidents: activeIncidents as Record<string, unknown>[],
  };
}

async function pollStatusPage(
  provider: ProviderName
): Promise<StatusPageResult | null> {
  const config = PROVIDER_STATUS_CONFIG[provider];
  if (!config.statusPageUrl || !config.statusPageType) return null;

  switch (config.statusPageType) {
    case "atlassian":
      return pollAtlassianStatuspage(
        config.statusPageUrl,
        config.componentNames
      );
    case "incidentio":
      return pollIncidentIO(config.statusPageUrl, config.componentNames);
    case "instatus":
      return pollInstatus(config.statusPageUrl, config.componentNames);
    case "google_cloud":
      return pollGoogleCloudStatus(config.componentNames);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Active health checks
// ---------------------------------------------------------------------------

async function runHealthCheck(
  provider: ProviderName
): Promise<HealthCheckResult> {
  const config = PROVIDER_STATUS_CONFIG[provider];
  const apiKey = process.env[config.healthCheckApiKeyEnv];

  if (!apiKey) {
    return { ok: false, latencyMs: 0, error: "API key not configured" };
  }

  let url = config.healthCheckUrl;

  // Google uses key as query param
  if (provider === "google") {
    url = url.replace("__KEY__", apiKey);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (provider === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (provider !== "google") {
    headers[config.healthCheckAuthHeader] =
      `${config.healthCheckAuthPrefix}${apiKey}`;
  }

  const start = Date.now();

  try {
    const res = await fetch(url, {
      method: config.healthCheckMethod,
      headers,
      body: config.healthCheckBody
        ? JSON.stringify(config.healthCheckBody)
        : undefined,
      signal: AbortSignal.timeout(15000),
    });

    const latencyMs = Date.now() - start;

    // 2xx or 4xx (auth/validation) means the service is reachable
    const ok = res.status < 500;

    return {
      ok,
      latencyMs,
      error: ok ? null : `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

// ---------------------------------------------------------------------------
// Usage-derived metrics
// ---------------------------------------------------------------------------

async function getUsageMetrics(
  provider: ProviderName
): Promise<UsageMetrics> {
  try {
    const supabase = getSupabase();
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from("api_call_logs")
      .select("status_code, latency_ms")
      .eq("provider", provider)
      .gte("created_at", fiveMinAgo);

    if (error || !data || data.length === 0) {
      return { successRate: null, errorRate: null, avgResponseMs: null };
    }

    const total = data.length;
    const successes = data.filter(
      (r: { status_code: number }) => r.status_code === 200
    ).length;
    const failures = total - successes;
    const avgMs =
      data.reduce(
        (sum: number, r: { latency_ms: number }) => sum + (r.latency_ms ?? 0),
        0
      ) / total;

    return {
      successRate: Math.round((successes / total) * 10000) / 100,
      errorRate: Math.round((failures / total) * 10000) / 100,
      avgResponseMs: Math.round(avgMs),
    };
  } catch {
    return { successRate: null, errorRate: null, avgResponseMs: null };
  }
}

// ---------------------------------------------------------------------------
// Status reconciliation
// ---------------------------------------------------------------------------

function statusSeverity(status: ProviderStatus | PlatformStatus): number {
  switch (status) {
    case "operational":
      return 0;
    case "degraded":
      return 1;
    case "partial_outage":
      return 2;
    case "major_outage":
    case "down":
      return 3;
    default:
      return -1;
  }
}

function reconcileStatus(
  statusPage: StatusPageResult | null,
  healthCheck: HealthCheckResult,
  usage: UsageMetrics
): ProviderStatus {
  // If status page reports an outage, trust it
  if (statusPage && statusSeverity(statusPage.status) >= 2) {
    return statusPage.status;
  }

  // Health check failed
  if (!healthCheck.ok) {
    // Status page says operational but health check fails → degraded
    if (statusPage?.status === "operational") return "degraded";
    // No status page data → rely on health check
    return "major_outage";
  }

  // Usage-derived: high error rate
  if (usage.errorRate !== null && usage.errorRate > 50) {
    return "degraded";
  }

  // Status page says degraded
  if (statusPage?.status === "degraded") return "degraded";

  // Everything looks good
  if (statusPage?.status === "operational" || !statusPage) {
    return "operational";
  }

  return statusPage.status;
}

// ---------------------------------------------------------------------------
// Platform health checks
// ---------------------------------------------------------------------------

async function checkADE(): Promise<PlatformCheckResult> {
  const baseUrl =
    process.env.ADE_BASE_URL ?? "https://ade-sandy.vercel.app";
  const start = Date.now();

  try {
    const res = await fetch(baseUrl, {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    const latencyMs = Date.now() - start;
    const ok = res.ok || res.status === 405 || res.status === 404;

    return {
      service: "ade",
      status: ok ? "operational" : "degraded",
      latencyMs,
      errorMessage: ok ? null : `HTTP ${res.status}`,
      metadata: null,
    };
  } catch (err) {
    return {
      service: "ade",
      status: "down",
      latencyMs: Date.now() - start,
      errorMessage: err instanceof Error ? err.message : "Unreachable",
      metadata: null,
    };
  }
}

async function checkSupabase(): Promise<PlatformCheckResult> {
  const start = Date.now();

  try {
    const supabase = getSupabase();
    const { error } = await supabase
      .from("conversations")
      .select("id", { count: "exact", head: true });
    const latencyMs = Date.now() - start;

    return {
      service: "supabase",
      status: error ? "degraded" : "operational",
      latencyMs,
      errorMessage: error ? error.message : null,
      metadata: null,
    };
  } catch (err) {
    return {
      service: "supabase",
      status: "down",
      latencyMs: Date.now() - start,
      errorMessage: err instanceof Error ? err.message : "Unreachable",
      metadata: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

async function checkProvider(
  provider: ProviderName
): Promise<ProviderCheckResult> {
  const [statusPage, healthCheck, usage] = await Promise.all([
    pollStatusPage(provider).catch(() => null),
    runHealthCheck(provider),
    getUsageMetrics(provider),
  ]);

  const status = reconcileStatus(statusPage, healthCheck, usage);

  return {
    provider,
    status,
    source: "reconciled",
    statusPageRaw: statusPage?.raw ?? null,
    healthCheckOk: healthCheck.ok,
    latencyMs: healthCheck.latencyMs,
    errorMessage: healthCheck.error,
    components: statusPage?.components ?? null,
    incidents: statusPage?.incidents ?? null,
    successRate: usage.successRate,
    errorRate: usage.errorRate,
    avgResponseMs: usage.avgResponseMs,
  };
}

export async function runStatusCheck(): Promise<StatusCheckResult> {
  const timestamp = new Date().toISOString();
  const supabase = getSupabase();

  // Run all checks in parallel
  const [providerResults, adeResult, supabaseResult] = await Promise.all([
    Promise.all(ALL_PROVIDERS.map(checkProvider)),
    checkADE(),
    checkSupabase(),
  ]);

  // ARC is operational since this code is executing
  const arcResult: PlatformCheckResult = {
    service: "arc",
    status: "operational",
    latencyMs: null,
    errorMessage: null,
    metadata: null,
  };

  const platformResults = [arcResult, adeResult, supabaseResult];

  // Determine overall status from worst provider
  let overall: ProviderStatus = "operational";
  for (const p of providerResults) {
    if (statusSeverity(p.status) > statusSeverity(overall)) {
      overall = p.status;
    }
  }
  for (const s of platformResults) {
    const mapped: ProviderStatus =
      s.status === "down" ? "major_outage" : (s.status as ProviderStatus);
    if (statusSeverity(mapped) > statusSeverity(overall)) {
      overall = mapped;
    }
  }

  // Write to Supabase (fire-and-forget, don't block response)
  const providerRows = providerResults.map((r) => ({
    provider: r.provider,
    status: r.status,
    source: r.source,
    status_page_raw: r.statusPageRaw,
    health_check_ok: r.healthCheckOk,
    latency_ms: r.latencyMs,
    error_message: r.errorMessage,
    components: r.components,
    incidents: r.incidents,
    checked_at: timestamp,
  }));

  const historyRows = providerResults.map((r) => ({
    provider: r.provider,
    status: r.status,
    latency_ms: r.latencyMs,
    success_rate: r.successRate,
    error_rate: r.errorRate,
    avg_response_ms: r.avgResponseMs,
    checked_at: timestamp,
  }));

  const platformRows = platformResults.map((r) => ({
    service: r.service,
    status: r.status,
    latency_ms: r.latencyMs,
    error_message: r.errorMessage,
    metadata: r.metadata,
    checked_at: timestamp,
  }));

  await Promise.all([
    supabase.from("provider_status").insert(providerRows),
    supabase.from("provider_status_history").insert(historyRows),
    supabase.from("platform_status").insert(platformRows),
  ]);

  return { providers: providerResults, platform: platformResults, overall, timestamp };
}
