'use client'

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import { apiFetch, ApiError } from '@/lib/api-client'
import { useSmartPoll } from '@/lib/use-smart-poll'
import { Button } from '@/components/ui/button'

interface Agent { id: number; name: string; status?: string; framework?: string; role?: string }

const ENDPOINTS = [
  ['GET  /api/tasks', 'list tasks; filter client-side by assigned_to'],
  ['PATCH /api/tasks/<id>', 'claim / update status (in_progress, review, done)'],
  ['GET  /api/board?board=<name>&since=<ts>', 'poll shared channel'],
  ['POST /api/board', '{board, content, to?} — post to a channel'],
  ['GET  /api/notifications', 'messages addressed to the agent'],
  ['POST /api/review-queue', 'submit a deliverable for human sign-off'],
  ['GET  /api/review-queue?status=changes_requested', 'pick up requested revisions'],
  ['POST /api/platform-integrations/<id>/metrics', '{metric, value, currency} — push telemetry'],
  ['PATCH /api/ventures/<id>', '{analytics: {chip: value}} — bump venture telemetry'],
]

function systemPrompt(baseUrl: string, keyHint: string) {
  return `You are a connected agent on this Mission Control workspace.
BASE URL: ${baseUrl}
AUTH: send header "x-api-key: ${keyHint || '<your issued key>'}" on every request.

Each shift:
1. GET /api/board?board=general — read the shared channel; reply with POST /api/board.
2. GET /api/tasks — find tasks assigned to you; PATCH status as you work.
3. Blocked or finished a deliverable? POST /api/review-queue with
   {title, summary, expected_target, delivered, evidence}.
   Poll GET /api/review-queue?status=changes_requested for feedback.
4. Report progress: POST /api/platform-integrations/<id>/metrics or
   PATCH /api/ventures/<id> {"analytics": {"emails_sent": 1450}}.
5. Post a shift summary to the board so other agents and the operator see it.`
}

export function AiControlPanel() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [keys, setKeys] = useState<Record<number, Array<{ id: number; name: string; key_prefix: string; scopes: string; created_at: number }>>>({})
  const [newKey, setNewKey] = useState<{ agent: string; api_key: string } | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  const baseUrl = useMemo(() => (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000'), [])

  const fetchAgents = useCallback(async () => {
    try {
      const data = await apiFetch<{ agents?: Agent[] } | Agent[]>('/api/agents')
      const list: Agent[] = Array.isArray(data) ? data : (data.agents ?? [])
      setAgents(list)
      const keyMap: typeof keys = {}
      await Promise.all(list.map(async (a) => {
        try {
          const r = await apiFetch<{ keys?: typeof keys[number] }>(`/api/agents/${a.id}/keys`)
          keyMap[a.id] = r.keys ?? []
        } catch { keyMap[a.id] = [] }
      }))
      setKeys(keyMap)
      setError('')
    } catch (e) {
      setError(e instanceof ApiError ? `${e.status} ${e.message}` : 'failed to load')
    }
  }, [])

  useSmartPoll(fetchAgents, 20000)

  const issueKey = async (agentId: number, name: string) => {
    try {
      const body = await apiFetch<{ api_key?: string; key?: string }>(`/api/agents/${agentId}/keys`, {
        method: 'POST',
        body: JSON.stringify({ name: `${name}-key`, scopes: ['operator'] }),
      })
      setNewKey({ agent: name, api_key: body.api_key || body.key || '' })
      fetchAgents()
    } catch (e) {
      setError(e instanceof ApiError ? `${e.status} ${e.message}` : 'issue failed')
    }
  }

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
  }

  return (
    <div className="space-y-6 p-6">
      <header>
        <div className="text-xs text-muted-foreground">CLOUDFLARE EDGE SECURITY</div>
        <h1 className="text-xl font-semibold">Agent API Keys &amp; Permissions</h1>
        <p className="text-sm text-muted-foreground">
          Issue keys for external AIs (Muse AI, ChatGPT, Claude, scripts). Agents authenticate with
          <code className="mx-1">x-api-key</code>; operator scope can post messages, update tasks and push metrics.
        </p>
      </header>

      {error && <div className="text-sm text-red-400">{error}</div>}

      {newKey && (
        <div className="rounded border border-void-cyan bg-card p-3 text-sm">
          <strong>{newKey.agent}</strong> key (shown once): <code className="break-all text-void-cyan">{newKey.api_key}</code>
          <Button className="ml-2" variant="outline" onClick={() => copy(newKey.api_key)}>Copy</Button>
        </div>
      )}

      <section className="rounded border border-border bg-card p-4">
        <h2 className="mb-2 font-semibold">Active Agent Tokens</h2>
        {agents.length === 0 && <div className="text-sm text-muted-foreground">No agents registered yet (Agents panel → Create).</div>}
        {agents.map((a) => (
          <div key={a.id} className="mb-2 rounded border border-border p-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="font-medium">{a.name}</span>
                <span className="ml-2 text-xs text-muted-foreground">{a.framework || a.role || a.status || ''}</span>
              </div>
              <Button variant="outline" onClick={() => issueKey(a.id, a.name)}>+ Issue New Key</Button>
            </div>
            {(keys[a.id] || []).map((k) => (
              <div key={k.id} className="mt-2 flex items-center gap-2 text-xs">
                <code className="text-void-cyan">{k.key_prefix}…</code>
                <span className="text-muted-foreground">{k.name}</span>
                <span className="rounded border border-border px-1">{k.scopes}</span>
              </div>
            ))}
          </div>
        ))}
      </section>

      <section className="rounded border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">External Agent Protocol</h2>
          <Link href="/docs" className="text-sm text-void-cyan">OpenAPI docs →</Link>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Paste this system prompt into ChatGPT / Claude / Cursor alongside an issued key. Full guide: <code>docs/external-agents.md</code>.
        </p>
        <div className="mt-2 flex justify-end">
          <Button variant="outline" onClick={() => copy(systemPrompt(baseUrl, newKey?.api_key || ''))}>{copied ? 'Copied!' : 'Copy System Prompt'}</Button>
        </div>
        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-background/80 p-3 text-xs">{systemPrompt(baseUrl, newKey?.api_key || '<YOUR_API_KEY>')}</pre>
      </section>

      <section className="rounded border border-border bg-card p-4">
        <h2 className="mb-2 font-semibold">Live Endpoints</h2>
        <table className="w-full text-xs">
          <tbody>
            {ENDPOINTS.map(([ep, desc]) => (
              <tr key={ep} className="border-b border-border last:border-0">
                <td className="py-1 pr-4 font-mono text-void-cyan">{ep}</td>
                <td className="py-1 text-muted-foreground">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}
