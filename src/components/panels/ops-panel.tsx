'use client'

import { useCallback, useState } from 'react'
import Link from 'next/link'
import { apiFetch, ApiError } from '@/lib/api-client'
import { useSmartPoll } from '@/lib/use-smart-poll'

interface Venture {
  id: number; name: string; category: string | null; status: string
  revenue_current: number; revenue_target: number | null; currency: string
  open_tasks: number; pending_reviews: number
  metrics: Array<{ metric: string; value: number; currency: string | null }>
}
interface Overview {
  revenue: { current: number; target: number }
  counts: { active_ventures: number; open_tasks: number; due_today: number; pending_reviews: number }
  ventures_ranked: Venture[]
  due_today: Array<{ id: number; title: string; status: string; assigned_to: string | null }>
  pending_reviews: Array<{ id: number; title: string; status: string; agent_name: string | null; project_name: string | null }>
}

const fmtMoney = (v: number) => `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`

function StatCard({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return (
    <div className="rounded border border-border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </div>
  )
}

export function OpsPanel() {
  const [data, setData] = useState<Overview | null>(null)
  const [error, setError] = useState('')

  const fetchOverview = useCallback(async () => {
    try {
      setData(await apiFetch<Overview>('/api/ops-overview'))
      setError('')
    } catch (e) {
      setError(e instanceof ApiError ? `${e.status} ${e.message}` : 'failed to load')
    }
  }, [])

  useSmartPoll(fetchOverview, 15000)

  if (!data) return <div className="p-6 text-muted-foreground">{error || 'Loading operations overview…'}</div>

  const pct = data.revenue.target > 0 ? Math.min(100, Math.round((data.revenue.current / data.revenue.target) * 100)) : 0

  return (
    <div className="space-y-6 p-6">
      <header>
        <div className="text-xs text-muted-foreground">EXECUTIVE DESK</div>
        <h1 className="text-xl font-semibold">Operations Overview</h1>
      </header>

      {error && <div className="text-sm text-red-400">{error}</div>}

      <section className="rounded border border-border bg-card p-4">
        <div className="text-xs text-muted-foreground">PORTFOLIO REVENUE VELOCITY</div>
        <div className="mt-1 flex items-baseline gap-3">
          <span className="text-2xl font-semibold">{fmtMoney(data.revenue.current)}</span>
          <span className="text-sm text-muted-foreground">/ {fmtMoney(data.revenue.target)} target revenue</span>
          <span className="ml-auto text-sm text-void-cyan">{pct}% achieved</span>
        </div>
        <div className="mt-2 h-2 rounded bg-border">
          <div className="h-2 rounded bg-void-cyan" style={{ width: `${pct}%` }} />
        </div>
      </section>

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="OPEN TASKS" value={data.counts.open_tasks} hint="Across all work queues" />
        <StatCard label="DUE TODAY" value={data.counts.due_today} hint="Scheduled for execution" />
        <StatCard label="ACTIVE VENTURES" value={data.counts.active_ventures} hint="Quantifiable milestones" />
        <StatCard label="REVIEW QUEUE" value={data.counts.pending_reviews} hint="AI deliverables waiting sign-off" />
      </section>

      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="font-semibold">Ventures Ranked By Action Required</h2>
          <Link href="/ventures" className="text-sm text-void-cyan">View All Hub →</Link>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.ventures_ranked.map((v) => (
            <div key={v.id} className="rounded border border-border bg-card p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs uppercase text-muted-foreground">{v.category || 'general'}</span>
                <span className="text-xs text-muted-foreground">{v.status}</span>
              </div>
              <div className="mt-1 font-medium">{v.name}</div>
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
              <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
                <span>{v.open_tasks} open tasks · {v.pending_reviews} pending reviews</span>
              </div>
            </div>
          ))}
          {data.ventures_ranked.length === 0 && (
            <div className="col-span-full rounded border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No ventures yet — create one in the Ventures panel.
            </div>
          )}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="rounded border border-border bg-card p-4">
          <h2 className="mb-2 font-semibold">On Your Desk Today <span className="text-sm font-normal text-muted-foreground">{data.due_today.length} items scheduled</span></h2>
          {data.due_today.length === 0 ? (
            <div className="py-4 text-center text-sm text-muted-foreground">All scheduled runs for today are complete.</div>
          ) : (
            <ul className="space-y-1 text-sm">
              {data.due_today.map((t) => (
                <li key={t.id} className="flex justify-between border-b border-border py-1 last:border-0">
                  <span>{t.title}</span>
                  <span className="text-muted-foreground">{t.assigned_to || t.status}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded border border-border bg-card p-4">
          <h2 className="mb-2 font-semibold">Sign-Off Review Queue <span className="text-sm font-normal text-muted-foreground">{data.pending_reviews.length} pending deliverables</span></h2>
          {data.pending_reviews.length === 0 ? (
            <div className="py-4 text-center text-sm text-muted-foreground">Nothing waiting for sign-off.</div>
          ) : (
            <ul className="space-y-2 text-sm">
              {data.pending_reviews.map((r) => (
                <li key={r.id} className="rounded border border-border p-2">
                  <div className="flex justify-between">
                    <span className="font-medium">{r.title}</span>
                    <span className="text-xs text-muted-foreground">{r.status.replace('_', ' ')}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">Agent: {r.agent_name || '—'}{r.project_name ? ` · ${r.project_name}` : ''}</div>
                  <Link href="/review-queue" className="mt-1 inline-block text-xs text-void-cyan">Inspect &amp; Sign Off →</Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
