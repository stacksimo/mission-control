import { decryptSecret } from '@/lib/secret-store'

// Platform adapters for revenue/metric tracking.
// Each adapter takes the decrypted credential + JSON config and returns metrics to snapshot.

export interface SyncMetric {
  metric: string
  value: number
  currency?: string
}

export interface SyncResult {
  ok: boolean
  metrics: SyncMetric[]
  error?: string
  raw?: unknown
}

interface IntegrationRow {
  id: number
  platform: string
  credential_enc: string | null
  config: string | null
}

function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86400_000)
  return d.toISOString().slice(0, 10)
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

async function fetchJson(url: string, headers: Record<string, string>, timeoutMs = 20000): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers, signal: controller.signal, redirect: 'error' })
    const text = await res.text()
    let body: unknown
    try { body = JSON.parse(text) } catch { body = text.slice(0, 4000) }
    return { status: res.status, body }
  } finally {
    clearTimeout(timer)
  }
}

// ClickBank Orders API: https://api.clickbank.com/rest/1.3/orders/...
// Auth: "Authorization: DEV-KEY:CLERK-KEY". Credential stored as "devKey:clerkKey".
async function syncClickbank(credential: string | null, config: Record<string, unknown>): Promise<SyncResult> {
  if (!credential) return { ok: false, metrics: [], error: 'ClickBank credential missing (expected format DEV_KEY:CLERK_KEY)' }
  const lookbackDays = typeof config.lookbackDays === 'number' ? Math.min(Math.max(config.lookbackDays, 1), 365) : 30
  const params = new URLSearchParams({ startDate: daysAgo(lookbackDays), endDate: today(), type: 'SALE' })
  const headers = { Authorization: credential, Accept: 'application/json' }

  const countRes = await fetchJson(`https://api.clickbank.com/rest/1.3/orders/count?${params}`, headers)
  if (countRes.status === 401 || countRes.status === 403) {
    return { ok: false, metrics: [], error: `ClickBank auth failed (HTTP ${countRes.status})` }
  }
  if (countRes.status >= 400) {
    return { ok: false, metrics: [], error: `ClickBank API error (HTTP ${countRes.status})`, raw: countRes.body }
  }

  const metrics: SyncMetric[] = []
  const countBody = countRes.body as Record<string, unknown>
  const orderCount = Number(countBody?.count ?? countBody?.orderCount ?? 0)
  metrics.push({ metric: 'orders_30d', value: Number.isFinite(orderCount) ? orderCount : 0 })

  // Pull up to 100 orders to sum gross revenue for the window.
  const listRes = await fetchJson(`https://api.clickbank.com/rest/1.3/orders/list?${params}`, headers)
  if (listRes.status < 400 && listRes.body) {
    const list = (listRes.body as Record<string, unknown>)?.orderData ?? (listRes.body as Record<string, unknown>)?.orders ?? []
    const orders = Array.isArray(list) ? list : []
    let revenue = 0
    let currency: string | undefined
    for (const order of orders) {
      const o = order as Record<string, unknown>
      const amount = Number(o.totalAmount ?? o.amount ?? o.netAmount ?? 0)
      if (Number.isFinite(amount)) revenue += amount
      if (typeof o.currency === 'string') currency = o.currency
    }
    metrics.push({ metric: 'revenue_30d', value: Math.round(revenue * 100) / 100, currency: currency || 'USD' })
  }

  return { ok: true, metrics, raw: { count: countRes.body } }
}

// Generic JSON endpoint: config = { url, headersTemplate, metrics: {name: "dot.path"}, timeoutMs? }
// Credential (if set) is substituted into {TOKEN} placeholders in url/headers.
function readPath(obj: unknown, path: string): unknown {
  let cur = obj
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

async function syncCustomHttp(credential: string | null, config: Record<string, unknown>): Promise<SyncResult> {
  const url = typeof config.url === 'string' ? config.url : null
  if (!url) return { ok: false, metrics: [], error: 'custom_http integration requires config.url' }
  const headersTemplate = (config.headers as Record<string, string> | undefined) || {}
  const token = credential || ''
  const headers: Record<string, string> = { Accept: 'application/json' }
  for (const [k, v] of Object.entries(headersTemplate)) {
    headers[k] = String(v).replaceAll('{TOKEN}', token)
  }
  const resolvedUrl = url.replaceAll('{TOKEN}', token)

  const res = await fetchJson(resolvedUrl, headers, Number(config.timeoutMs) || 20000)
  if (res.status >= 400) {
    return { ok: false, metrics: [], error: `HTTP ${res.status} from ${new URL(resolvedUrl).host}`, raw: res.body }
  }

  const metricMap = (config.metrics as Record<string, string> | undefined) || {}
  const metrics: SyncMetric[] = []
  for (const [name, path] of Object.entries(metricMap)) {
    const val = Number(readPath(res.body, path))
    metrics.push({ metric: name, value: Number.isFinite(val) ? val : 0 })
  }
  if (metrics.length === 0) {
    metrics.push({ metric: 'fetch_ok', value: 1 })
  }
  return { ok: true, metrics, raw: res.body }
}

export async function runPlatformSync(integration: IntegrationRow): Promise<SyncResult> {
  let config: Record<string, unknown> = {}
  try {
    config = integration.config ? JSON.parse(integration.config) : {}
  } catch {
    return { ok: false, metrics: [], error: 'Invalid JSON in integration config' }
  }

  let credential: string | null = null
  if (integration.credential_enc) {
    try {
      credential = decryptSecret(integration.credential_enc)
    } catch {
      return { ok: false, metrics: [], error: 'Failed to decrypt stored credential' }
    }
  }

  switch (integration.platform) {
    case 'clickbank':
      return syncClickbank(credential, config)
    case 'custom_http':
      return syncCustomHttp(credential, config)
    case 'manual':
      return { ok: true, metrics: [], raw: { note: 'manual integration — metrics are pushed via API' } }
    default:
      return { ok: false, metrics: [], error: `Unknown platform "${integration.platform}"` }
  }
}
