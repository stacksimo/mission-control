'use client'

import { useCallback, useState } from 'react'
import { apiFetch, ApiError } from '@/lib/api-client'
import { useSmartPoll } from '@/lib/use-smart-poll'
import { Button } from '@/components/ui/button'

interface ReviewItem {
  id: number; title: string; summary: string | null; expected_target: string | null
  delivered: string | null; evidence: string | null; status: string
  agent_name: string | null; project_name: string | null; feedback: string | null
  created_at: number; reviewed_by: string | null
}
interface Counts { status: string; c: number }

const TABS = [
  { key: '', label: 'All Items' },
  { key: 'pending', label: 'Pending Review' },
  { key: 'changes_requested', label: 'Changes Requested' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
]

const STATUS_BADGE: Record<string, string> = {
  pending: 'border-yellow-600/50 text-yellow-400',
  changes_requested: 'border-orange-600/50 text-orange-400',
  approved: 'border-green-600/50 text-green-400',
  rejected: 'border-red-600/50 text-red-400',
}

export function ReviewQueuePanel() {
  const [items, setItems] = useState<ReviewItem[]>([])
  const [counts, setCounts] = useState<Counts[]>([])
  const [tab, setTab] = useState('pending')
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [feedbackFor, setFeedbackFor] = useState<Record<number, string>>({})
  const [showSubmit, setShowSubmit] = useState(false)
  const [form, setForm] = useState({ title: '', summary: '', expected_target: '', delivered: '', evidence: '' })
  const [error, setError] = useState('')

  const fetchQueue = useCallback(async () => {
    try {
      const data = await apiFetch<{ items: ReviewItem[]; counts: Counts[] }>(`/api/review-queue${tab ? `?status=${tab}` : ''}`)
      setItems(data.items)
      setCounts(data.counts)
      setError('')
    } catch (e) {
      setError(e instanceof ApiError ? `${e.status} ${e.message}` : 'failed to load')
    }
  }, [tab])

  useSmartPoll(fetchQueue, 8000)

  const decide = async (id: number, action: string) => {
    try {
      await apiFetch(`/api/review-queue/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action, feedback: feedbackFor[id] || undefined }),
      })
      setFeedbackFor((f) => ({ ...f, [id]: '' }))
      fetchQueue()
    } catch (e) {
      setError(e instanceof ApiError ? `${e.status} ${e.message}` : 'decision failed')
    }
  }

  const remove = async (id: number) => {
    try { await apiFetch(`/api/review-queue/${id}`, { method: 'DELETE' }) } catch { /* ignore */ }
    fetchQueue()
  }

  const submit = async () => {
    try {
      await apiFetch('/api/review-queue', {
        method: 'POST',
        body: JSON.stringify(form),
      })
      setForm({ title: '', summary: '', expected_target: '', delivered: '', evidence: '' })
      setShowSubmit(false)
      fetchQueue()
    } catch (e) {
      setError(e instanceof ApiError ? `${e.status} ${e.message}` : 'submit failed')
    }
  }

  const countFor = (key: string) => counts.find((c) => c.status === key)?.c ?? 0
  const totalCount = counts.reduce((s, c) => s + c.c, 0)
  const inputCls = 'w-full rounded border border-border bg-background px-2 py-1 text-sm'

  const parseFeedback = (raw: string | null): Array<{ actor: string; note: string }> => {
    try { return raw ? JSON.parse(raw) : [] } catch { return [] }
  }

  return (
    <div className="space-y-4 p-6">
      <header className="flex items-center justify-between">
        <div>
          <div className="text-xs text-muted-foreground">SIGN-OFF REVIEW QUEUE</div>
          <h1 className="text-xl font-semibold">Human Sign-Off Review Desk</h1>
          <p className="text-sm text-muted-foreground">
            Supervise autonomous agent output, inspect evidence/copy, request revisions, and sign off before live execution.
          </p>
        </div>
        <Button onClick={() => setShowSubmit((s) => !s)}>+ Submit Deliverable</Button>
      </header>

      {error && <div className="text-sm text-red-400">{error}</div>}

      {showSubmit && (
        <section className="space-y-2 rounded border border-border bg-card p-4">
          <input className={inputCls} placeholder="Deliverable title" value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <input className={inputCls} placeholder="Summary" value={form.summary}
            onChange={(e) => setForm({ ...form, summary: e.target.value })} />
          <div className="grid grid-cols-2 gap-2">
            <input className={inputCls} placeholder="Expected target" value={form.expected_target}
              onChange={(e) => setForm({ ...form, expected_target: e.target.value })} />
            <input className={inputCls} placeholder="Actual delivered" value={form.delivered}
              onChange={(e) => setForm({ ...form, delivered: e.target.value })} />
          </div>
          <textarea className={inputCls} rows={4} placeholder="Raw evidence / copy" value={form.evidence}
            onChange={(e) => setForm({ ...form, evidence: e.target.value })} />
          <Button onClick={submit} disabled={!form.title.trim()}>Submit for review</Button>
        </section>
      )}

      <div className="flex gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded border px-3 py-1 text-sm ${tab === t.key ? 'border-void-cyan text-void-cyan' : 'border-border text-muted-foreground'}`}
          >
            {t.label} ({t.key === '' ? totalCount : countFor(t.key)})
          </button>
        ))}
      </div>

      <section className="space-y-4">
        {items.map((item) => (
          <div key={item.id} className="rounded border border-border bg-card p-4">
            <div className="flex items-start justify-between">
              <div>
                <span className="font-medium">{item.title}</span>
                <span className={`ml-2 rounded border px-1.5 py-0.5 text-xs ${STATUS_BADGE[item.status] || 'border-border text-muted-foreground'}`}>
                  {item.status.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())}
                </span>
                <div className="mt-1 text-xs text-muted-foreground">
                  {item.project_name || 'General'}
                  <span className="ml-2">Agent: {item.agent_name || '—'}</span>
                  <span className="ml-2">· Submitted {new Date(item.created_at * 1000).toLocaleDateString()}</span>
                </div>
              </div>
              <button className="text-xs text-muted-foreground hover:text-red-400" onClick={() => remove(item.id)} title="Delete review">✕</button>
            </div>

            {item.summary && <p className="mt-2 text-sm">{item.summary}</p>}

            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="rounded bg-background/60 p-2">
                <div className="text-xs text-void-cyan">EXPECTED TARGET</div>
                <div className="mt-1 text-sm">{item.expected_target || '—'}</div>
              </div>
              <div className="rounded bg-background/60 p-2">
                <div className="text-xs text-void-cyan">ACTUAL DELIVERED</div>
                <div className="mt-1 text-sm">{item.delivered || '—'}</div>
              </div>
            </div>

            {item.evidence && (
              <button
                className="mt-2 text-xs text-void-cyan"
                onClick={() => setExpanded((s) => { const n = new Set(s); n.has(item.id) ? n.delete(item.id) : n.add(item.id); return n })}
              >
                {expanded.has(item.id) ? '▾' : '▸'} Inspect Raw Evidence / Copy
              </button>
            )}
            {expanded.has(item.id) && item.evidence && (
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-background/80 p-2 text-xs">{item.evidence}</pre>
            )}

            {parseFeedback(item.feedback).length > 0 && (
              <div className="mt-3">
                <div className="text-xs text-muted-foreground">OPERATOR FEEDBACK TRACE</div>
                {parseFeedback(item.feedback).map((f, i) => (
                  <div key={i} className="mt-1 rounded border-l-2 border-yellow-600/60 bg-background/60 px-2 py-1 text-xs">
                    <strong>{f.actor}:</strong> {f.note}
                  </div>
                ))}
              </div>
            )}

            {['pending', 'changes_requested'].includes(item.status) && (
              <div className="mt-3 space-y-2">
                <input
                  className={inputCls}
                  placeholder="Feedback for the agent (optional)"
                  value={feedbackFor[item.id] || ''}
                  onChange={(e) => setFeedbackFor((f) => ({ ...f, [item.id]: e.target.value }))}
                />
                <div className="flex items-center gap-2">
                  <Button onClick={() => decide(item.id, 'approve')}>✓ Approve &amp; Sign Off</Button>
                  <Button variant="outline" onClick={() => decide(item.id, 'request_changes')}>⧗ Request Changes</Button>
                  <Button variant="destructive" onClick={() => decide(item.id, 'reject')}>✕ Reject</Button>
                  <button className="ml-auto text-xs text-muted-foreground hover:text-red-400" onClick={() => remove(item.id)}>
                    Remove from queue
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
        {items.length === 0 && (
          <div className="rounded border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No deliverables in this state. Agents submit evidence via POST /api/review-queue.
          </div>
        )}
      </section>
    </div>
  )
}
