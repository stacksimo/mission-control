'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api-client'
import { useSmartPoll } from '@/lib/use-smart-poll'

interface BoardSummary {
  conversation_id: string
  message_count: number
  last_activity: number
  last_message: string | null
  last_sender: string | null
}

interface BoardMessage {
  id: number
  conversation_id: string
  from_agent: string
  to_agent: string | null
  content: string
  message_type: string
  created_at: number
}

function boardSlug(conversationId: string): string {
  return conversationId.replace(/^board:/, '')
}

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function BoardPanel() {
  const [boards, setBoards] = useState<BoardSummary[]>([])
  const [activeBoard, setActiveBoard] = useState('general')
  const [messages, setMessages] = useState<BoardMessage[]>([])
  const [draft, setDraft] = useState('')
  const [newBoard, setNewBoard] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const lastTs = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  const fetchBoards = useCallback(async () => {
    try {
      const data = await apiFetch<{ conversations?: BoardSummary[] }>('/api/board')
      setBoards(data.conversations || [])
      setError('')
    } catch {
      setError('Failed to load boards')
    }
  }, [])

  const fetchMessages = useCallback(async () => {
    try {
      const data = await apiFetch<{ messages?: BoardMessage[] }>(
        `/api/board?board=${encodeURIComponent(activeBoard)}&since=${lastTs.current}&limit=200`
      )
      const incoming = data.messages || []
      if (incoming.length > 0) {
        lastTs.current = Math.max(...incoming.map(m => m.created_at))
        setMessages(prev => {
          const seen = new Set(prev.map(m => m.id))
          return [...prev, ...incoming.filter(m => !seen.has(m.id))]
        })
      }
    } catch { /* keep polling quietly */ }
  }, [activeBoard])

  useEffect(() => {
    lastTs.current = 0
    setMessages([])
  }, [activeBoard])

  useSmartPoll(fetchBoards, 15000, { pauseWhenDisconnected: true })
  useSmartPoll(fetchMessages, 4000, { pauseWhenDisconnected: true })

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length])

  async function send() {
    const content = draft.trim()
    if (!content || sending) return
    setSending(true)
    try {
      await apiFetch('/api/board', {
        method: 'POST',
        body: JSON.stringify({ board: activeBoard, content }),
      })
      setDraft('')
      await fetchMessages()
      fetchBoards()
    } catch {
      setError('Failed to send message')
    } finally {
      setSending(false)
    }
  }

  function openNewBoard() {
    const slug = newBoard.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
    if (!slug) return
    setActiveBoard(slug)
    setNewBoard('')
  }

  return (
    <div className="flex h-[calc(100vh-140px)]">
      <div className="w-64 shrink-0 border-r border-border flex flex-col">
        <div className="px-3 py-2.5 border-b border-border flex items-center justify-between">
          <span className="text-sm font-medium">Boards</span>
          <span className="text-xs text-muted-foreground">{boards.length}</span>
        </div>
        <div className="flex-1 overflow-y-auto">
          {boards.map(b => (
            <button
              key={b.conversation_id}
              onClick={() => setActiveBoard(boardSlug(b.conversation_id))}
              className={`w-full text-left px-3 py-2.5 border-b border-border/50 hover:bg-card transition-colors ${boardSlug(b.conversation_id) === activeBoard ? 'bg-card border-l-2 border-l-void-cyan' : ''}`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium truncate">#{boardSlug(b.conversation_id)}</span>
                <span className="text-[10px] text-muted-foreground">{b.message_count}</span>
              </div>
              {b.last_message && (
                <p className="text-xs text-muted-foreground truncate mt-0.5">
                  {b.last_sender}: {b.last_message}
                </p>
              )}
            </button>
          ))}
          {boards.length === 0 && (
            <p className="text-xs text-muted-foreground px-3 py-4">No boards yet. Post a message to create one.</p>
          )}
        </div>
        <div className="p-2 border-t border-border flex gap-1.5">
          <input
            value={newBoard}
            onChange={e => setNewBoard(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && openNewBoard()}
            placeholder="new-board-name"
            className="flex-1 min-w-0 bg-background border border-border rounded px-2 py-1.5 text-xs"
          />
          <Button size="sm" variant="ghost" onClick={openNewBoard} className="h-7 px-2 text-xs">+</Button>
        </div>
      </div>

      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
          <span className="text-sm font-medium">#{activeBoard}</span>
          <span className="text-xs text-muted-foreground">shared channel — agents and you</span>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {error && <p className="text-xs text-destructive">{error}</p>}
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <p className="text-sm text-muted-foreground">No messages in #{activeBoard} yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Agents post here via <code className="text-void-cyan">POST /api/board</code> — you can reply below
              </p>
            </div>
          )}
          {messages.map(m => (
            <div key={m.id} className="group">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-medium text-void-cyan">{m.from_agent}</span>
                {m.to_agent && <span className="text-xs text-muted-foreground">→ {m.to_agent}</span>}
                <span className="text-[10px] text-muted-foreground">{formatTime(m.created_at)}</span>
              </div>
              <p className="text-sm mt-0.5 whitespace-pre-wrap break-words">{m.content}</p>
            </div>
          ))}
        </div>

        <div className="border-t border-border p-3">
          <div className="flex gap-2">
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
              placeholder={`Message #${activeBoard} — visible to all connected agents`}
              rows={2}
              className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm resize-none"
            />
            <Button onClick={send} disabled={!draft.trim() || sending} className="self-end">
              Send
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
