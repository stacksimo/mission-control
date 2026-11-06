'use client'

import { useCallback, useState } from 'react'
import Link from 'next/link'
import { apiFetch, ApiError } from '@/lib/api-client'
import { useSmartPoll } from '@/lib/use-smart-poll'
import { Button } from '@/components/ui/button'

interface Venture {
  id: number; name: string; slug: string; description: string | null; status: string
  category: string | null; revenue_target: number | null; revenue_current: number; currency: string
  analytics: Record<string, unknown>; open_tasks: number; pending_reviews: number
  metrics: Array<{ metric: string; value: number; currency: string | null }>
}

const fmtMoney = (v: number) => `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`

export function VenturesPanel() {
  const [ventures, setVentures] = useState<Venture[]>([])
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ name: '', category: '', description: '', revenue_target: '' })

  const fetchVentures = useCallback(async () => {
    try {
      const data = await apiFetch<{ ventures: Venture[] }>('/api/ventures')
      setVentures(data.ventures)
      setError('')
    } catch (e) {
      setError(e instanceof ApiError ? `${e.status} ${e.message}` : 'failed to load')
    }
  }, [])

  useSmartPoll(fetchVentures, 15000)

  const createVenture = async () => {
    try {
      await apiFetch('/api/ventures', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          category: form.category || null,
          description: form.description || null,
          revenue_target: form.revenue_target ? Number(form.revenue_target) : null,
        }),
      })
      setForm({ name: '', category: '', description: '', revenue_target: '' })
      setShowForm(false)
      fetchVentures()
    } catch (e) {
      setError(e instanceof ApiError ? `${e.status} ${e.message}` : 'create failed')
    }
  }

  const inputCls = 'rounded border border-border bg-background px-2 py-1 text-sm'

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <div className="text-xs text-muted-foreground">PORTFOLIO OPERATIONS</div>
          <h1 className="text-xl font-semibold">All Ventures Hub</h1>
        </div>
        <Button onClick={() => setShowForm((s) => !s)}>+ Create Venture</Button>
      </header>

      {error && <div className="text-sm text-red-400">{error}</div>}

      {showForm && (
        <section className="space-y-2 rounded border border-border bg-card p-4">
          <input className={inputCls} placeholder="Venture name" value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className={inputCls} placeholder="Category (e.g. affiliate, ecommerce)" value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })} />
          <input className={inputCls} placeholder="Monthly revenue target" value={form.revenue_target}
            onChange={(e) => setForm({ ...form, revenue_target: e.target.value })} />
          <input className={`${inputCls} w-full`} placeholder="Description" value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <div>
            <Button onClick={createVenture} disabled={!form.name.trim()}>Create</Button>
          </div>
        </section>
      )}

      <section>
        <div className="mb-2 text-xs text-muted-foreground">VENTURES RANKED BY ACTION REQUIRED (INCOMPLETE TASKS FIRST)</div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {ventures.map((v) => {
            const chips = [
              ...v.metrics.filter((m) => m.metric !== 'revenue').map((m) => ({ label: m.metric, value: m.value })),
              ...Object.entries(v.analytics).filter(([k]) => k !== 'revenue').map(([k, val]) => ({ label: k, value: val })),
            ]
            return (
              <div key={v.id} className="rounded border border-border bg-card p-4">
                <div className="flex items-center justify-between text-xs">
                  <span className="uppercase text-muted-foreground">{v.category || 'general'}</span>
                  <span className="text-muted-foreground">{v.status === 'active' ? 'Idle' : v.status}</span>
                </div>
                <div className="mt-1 font-medium">{v.name}</div>
                {v.description && <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{v.description}</div>}
                <div className="mt-3 text-xs text-muted-foreground">
                  Monthly Revenue
                  <span className="float-right text-foreground">
                    {fmtMoney(v.revenue_current)}{v.revenue_target ? ` / ${fmtMoney(v.revenue_target)}` : ''}
                  </span>
                </div>
                {v.revenue_target ? (
                  <div className="mt-1 h-1.5 rounded bg-border">
                    <div className="h-1.5 rounded bg-void-cyan" style={{ width: `${Math.min(100, (v.revenue_current / v.revenue_target) * 100)}%` }} />
                  </div>
                ) : null}
                {chips.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {chips.slice(0, 8).map((c) => (
                      <span key={c.label} className="rounded border border-border px-1.5 py-0.5 text-xs">
                        <strong>{String(c.value)}</strong> <span className="text-muted-foreground">{c.label}</span>
                      </span>
                    ))}
                  </div>
                )}
                <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
                  <span>{v.open_tasks} open tasks · {v.pending_reviews} reviews</span>
                  <Link href="/tasks" className="text-void-cyan">Scope Tasks →</Link>
                </div>
              </div>
            )
          })}
          {ventures.length === 0 && (
            <div className="col-span-full rounded border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              No ventures yet. Create one to group tasks, agents and platform metrics by project category
              (digital products, affiliate marketing, freelancing, …).
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
