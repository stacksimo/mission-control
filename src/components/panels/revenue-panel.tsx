'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { apiFetch, ApiError } from '@/lib/api-client'
import { useSmartPoll } from '@/lib/use-smart-poll'
import { useMissionControl } from '@/store'

interface Metric {
  metric: string
  value: number
  currency: string | null
  captured_at: number
  source: string
}

interface Integration {
  id: number
  platform: string
  name: string
  project_id: number | null
  project_name: string | null
  enabled: number
  has_credential: boolean
  last_sync_at: number | null
  last_sync_status: string | null
  last_error: string | null
  created_at: number
  metrics: Metric[]
}

interface Project {
  id: number
  name: string
  slug: string
}

const PLATFORM_LABELS: Record<string, string> = {
  clickbank: 'ClickBank',
  custom_http: 'Custom API',
  manual: 'Manual / agent-reported',
}

function fmtMetric(m: Metric): string {
  if (m.currency) return `${m.currency} ${m.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return m.value.toLocaleString()
}

function timeAgo(ts: number | null): string {
  if (!ts) return 'never'
  const diff = Math.floor(Date.now() / 1000) - ts
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

export function RevenuePanel() {
  const { projects, fetchProjects } = useMissionControl()
  const [integrations, setIntegrations] = useState<Integration[]>([])
  const [error, setError] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [syncing, setSyncing] = useState<number | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)

  // add-form state
  const [form, setForm] = useState({ name: '', platform: 'clickbank', credential: '', project_id: '', url: '', metricsJson: '', lookbackDays: '30' })

  const fetchIntegrations = useCallback(async () => {
    try {
      const data = await apiFetch<{ integrations?: Integration[] }>('/api/platform-integrations')
      setIntegrations(data.integrations || [])
      setError('')
    } catch {
      setError('Failed to load integrations')
    }
  }, [])

  useEffect(() => { fetchProjects() }, [fetchProjects])
  useSmartPoll(fetchIntegrations, 30000, { pauseWhenDisconnected: true })
  useEffect(() => { fetchIntegrations() }, [fetchIntegrations])

  async function createIntegration() {
    try {
      const config: Record<string, unknown> = {}
      if (form.platform === 'clickbank' && form.lookbackDays) config.lookbackDays = Number(form.lookbackDays)
      if (form.platform === 'custom_http') {
        config.url = form.url
        if (form.metricsJson.trim()) config.metrics = JSON.parse(form.metricsJson)
      }
      await apiFetch('/api/platform-integrations', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.trim(),
          platform: form.platform,
          credential: form.credential.trim() || undefined,
          project_id: form.project_id ? Number(form.project_id) : undefined,
          config,
        }),
      })
      setShowAdd(false)
      setForm({ name: '', platform: 'clickbank', credential: '', project_id: '', url: '', metricsJson: '', lookbackDays: '30' })
      fetchIntegrations()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create integration')
    }
  }

  async function syncNow(id: number) {
    setSyncing(id)
    try {
      await apiFetch(`/api/platform-integrations/${id}/sync`, { method: 'POST' })
      await fetchIntegrations()
    } catch {
      setError('Sync failed')
    } finally {
      setSyncing(null)
    }
  }

  async function toggleEnabled(integration: Integration) {
    await apiFetch(`/api/platform-integrations/${integration.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: !integration.enabled }),
    })
    fetchIntegrations()
  }

  async function remove(id: number) {
    if (!confirm('Delete this integration and its metric history?')) return
    await apiFetch(`/api/platform-integrations/${id}`, { method: 'DELETE' })
    fetchIntegrations()
  }

  const projectList = (projects || []) as Project[]

  return (
    <div className="p-4 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Revenue Integrations</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Connect platforms (ClickBank, custom APIs) or let agents push metrics — tracked per project
          </p>
        </div>
        <Button onClick={() => setShowAdd(v => !v)}>{showAdd ? 'Cancel' : '+ Add Integration'}</Button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {showAdd && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">Name</label>
              <input
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="ClickBank — main account"
                className="w-full mt-1 bg-background border border-border rounded px-2.5 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Platform</label>
              <select
                value={form.platform}
                onChange={e => setForm(f => ({ ...f, platform: e.target.value }))}
                className="w-full mt-1 bg-background border border-border rounded px-2.5 py-1.5 text-sm"
              >
                <option value="clickbank">ClickBank</option>
                <option value="custom_http">Custom JSON API</option>
                <option value="manual">Manual / agent-reported</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Project</label>
              <select
                value={form.project_id}
                onChange={e => setForm(f => ({ ...f, project_id: e.target.value }))}
                className="w-full mt-1 bg-background border border-border rounded px-2.5 py-1.5 text-sm"
              >
                <option value="">— unassigned —</option>
                {projectList.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            {form.platform === 'clickbank' && (
              <>
                <div>
                  <label className="text-xs text-muted-foreground">Credential (DEV_KEY:CLERK_KEY)</label>
                  <input
                    value={form.credential}
                    onChange={e => setForm(f => ({ ...f, credential: e.target.value }))}
                    placeholder="DEV-KEY:API-KEY"
                    type="password"
                    className="w-full mt-1 bg-background border border-border rounded px-2.5 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Lookback days</label>
                  <input
                    value={form.lookbackDays}
                    onChange={e => setForm(f => ({ ...f, lookbackDays: e.target.value }))}
                    type="number" min={1} max={365}
                    className="w-full mt-1 bg-background border border-border rounded px-2.5 py-1.5 text-sm"
                  />
                </div>
              </>
            )}
            {form.platform === 'custom_http' && (
              <>
                <div className="col-span-2">
                  <label className="text-xs text-muted-foreground">Endpoint URL ({'{TOKEN}'} placeholder allowed)</label>
                  <input
                    value={form.url}
                    onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
                    placeholder="https://api.example.com/stats?key={TOKEN}"
                    className="w-full mt-1 bg-background border border-border rounded px-2.5 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Credential / token (optional)</label>
                  <input
                    value={form.credential}
                    onChange={e => setForm(f => ({ ...f, credential: e.target.value }))}
                    type="password"
                    className="w-full mt-1 bg-background border border-border rounded px-2.5 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Metric map (JSON)</label>
                  <input
                    value={form.metricsJson}
                    onChange={e => setForm(f => ({ ...f, metricsJson: e.target.value }))}
                    placeholder='{"revenue": "data.total", "orders": "data.count"}'
                    className="w-full mt-1 bg-background border border-border rounded px-2.5 py-1.5 text-sm"
                  />
                </div>
              </>
            )}
            {form.platform === 'manual' && (
              <p className="col-span-2 text-xs text-muted-foreground">
                Agents push metrics with <code className="text-void-cyan">POST /api/platform-integrations/&lt;id&gt;/metrics</code> — no remote fetch needed.
              </p>
            )}
          </div>
          <Button onClick={createIntegration} disabled={!form.name.trim()}>Create</Button>
        </div>
      )}

      {integrations.length === 0 && !showAdd && (
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <p className="text-sm text-muted-foreground">No integrations yet</p>
          <p className="text-xs text-muted-foreground mt-1">Add ClickBank or a custom API to start tracking revenue automatically</p>
        </div>
      )}

      <div className="space-y-2">
        {integrations.map(integration => (
          <div key={integration.id} className="rounded-lg border border-border bg-card overflow-hidden">
            <div className="px-4 py-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{integration.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground">
                    {PLATFORM_LABELS[integration.platform] || integration.platform}
                  </span>
                  {integration.project_name && (
                    <span className="text-[10px] text-muted-foreground">{integration.project_name}</span>
                  )}
                  {!integration.enabled && <span className="text-[10px] text-muted-foreground">(disabled)</span>}
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {integration.last_sync_status === 'ok' && `Synced ${timeAgo(integration.last_sync_at)}`}
                  {integration.last_sync_status === 'error' && <span className="text-destructive">Sync failed: {integration.last_error}</span>}
                  {!integration.last_sync_status && 'Never synced'}
                  {integration.has_credential && ' · credential stored'}
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => syncNow(integration.id)} disabled={syncing === integration.id}>
                  {syncing === integration.id ? 'Syncing…' : 'Sync'}
                </Button>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => toggleEnabled(integration)}>
                  {integration.enabled ? 'Disable' : 'Enable'}
                </Button>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setExpandedId(expandedId === integration.id ? null : integration.id)}>
                  {expandedId === integration.id ? 'Hide' : 'Metrics'}
                </Button>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive" onClick={() => remove(integration.id)}>
                  Delete
                </Button>
              </div>
            </div>

            {integration.metrics.length > 0 && (
              <div className="px-4 pb-3 flex flex-wrap gap-2">
                {integration.metrics.map(m => (
                  <div key={`${m.metric}-${m.captured_at}`} className="rounded border border-border px-2.5 py-1.5">
                    <div className="text-[10px] text-muted-foreground">{m.metric}</div>
                    <div className="text-sm font-medium">{fmtMetric(m)}</div>
                  </div>
                ))}
              </div>
            )}

            {expandedId === integration.id && (
              <IntegrationHistory id={integration.id} />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function IntegrationHistory({ id }: { id: number }) {
  const [metrics, setMetrics] = useState<Metric[]>([])

  useEffect(() => {
    apiFetch<{ metrics?: Metric[] }>(`/api/platform-integrations/${id}/metrics?limit=100`)
      .then(d => setMetrics(d.metrics || []))
      .catch(() => setMetrics([]))
  }, [id])

  if (metrics.length === 0) return <p className="px-4 pb-3 text-xs text-muted-foreground">No metric history yet</p>

  return (
    <div className="px-4 pb-3 max-h-48 overflow-y-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted-foreground text-left">
            <th className="py-1 font-normal">Metric</th>
            <th className="py-1 font-normal">Value</th>
            <th className="py-1 font-normal">Source</th>
            <th className="py-1 font-normal">When</th>
          </tr>
        </thead>
        <tbody>
          {[...metrics].reverse().slice(0, 50).map((m, i) => (
            <tr key={i} className="border-t border-border/50">
              <td className="py-1">{m.metric}</td>
              <td className="py-1 font-medium">{fmtMetric(m)}</td>
              <td className="py-1 text-muted-foreground">{m.source}</td>
              <td className="py-1 text-muted-foreground">{timeAgo(m.captured_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
