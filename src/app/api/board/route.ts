import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, db_helpers } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { eventBus } from '@/lib/event-bus'
import { mutationLimiter } from '@/lib/rate-limit'
import { scanForSecrets } from '@/lib/secret-scanner'
import { logSecurityEvent } from '@/lib/security-events'
import { logger } from '@/lib/logger'

// Shared agent board: a lightweight multi-party channel backed by the messages
// table. Conversations use the "board:<slug>" convention so external agents
// (ChatGPT, Claude, Muse AI, scripts) can post/read via API key, and the user
// can watch and join from the Board panel.

const BOARD_PREFIX = 'board:'

function sanitizeSlug(raw: unknown): string {
  const slug = String(raw ?? 'general').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return (slug || 'general').slice(0, 64)
}

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const db = getDatabase()
  const workspaceId = auth.user.workspace_id ?? 1
  const { searchParams } = new URL(request.url)
  const boardParam = searchParams.get('board')

  if (!boardParam) {
    const conversations = db.prepare(`
      SELECT conversation_id, COUNT(*) as message_count, MAX(created_at) as last_activity,
             (SELECT content FROM messages m2 WHERE m2.conversation_id = m.conversation_id ORDER BY created_at DESC, id DESC LIMIT 1) as last_message,
             (SELECT from_agent FROM messages m3 WHERE m3.conversation_id = m.conversation_id ORDER BY created_at DESC, id DESC LIMIT 1) as last_sender
      FROM messages m
      WHERE workspace_id = ? AND conversation_id LIKE ?
      GROUP BY conversation_id
      ORDER BY last_activity DESC
      LIMIT 100
    `).all(workspaceId, `${BOARD_PREFIX}%`)
    return NextResponse.json({ conversations })
  }

  const conversationId = BOARD_PREFIX + sanitizeSlug(boardParam)
  const since = Number(searchParams.get('since') || 0)
  const limit = Math.min(Number(searchParams.get('limit') || 100), 500)

  const messages = db.prepare(`
    SELECT id, conversation_id, from_agent, to_agent, content, message_type, metadata, created_at
    FROM messages
    WHERE workspace_id = ? AND conversation_id = ? AND created_at > ?
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `).all(workspaceId, conversationId, Number.isFinite(since) ? since : 0, limit)

  return NextResponse.json({ conversation_id: conversationId, messages })
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const body = await request.json()

    const content = String(body.content ?? '').trim()
    if (!content) return NextResponse.json({ error: '"content" is required' }, { status: 400 })
    if (content.length > 8000) return NextResponse.json({ error: '"content" too long (max 8000 chars)' }, { status: 400 })

    const conversationId = BOARD_PREFIX + sanitizeSlug(body.board ?? body.conversation ?? 'general')
    const to = typeof body.to === 'string' && body.to.trim() ? body.to.trim() : null
    const from = auth.user.display_name || auth.user.username || 'system'

    const secretHits = scanForSecrets(content)
    if (secretHits.length > 0) {
      try {
        logSecurityEvent({
          event_type: 'secret_exposure', severity: 'warning', source: 'board-message',
          agent_name: from, detail: JSON.stringify({ count: secretHits.length, types: secretHits.map(s => s.type) }),
          workspace_id: workspaceId, tenant_id: auth.user.tenant_id ?? 1,
        })
      } catch { /* non-fatal */ }
    }

    const metadata = body.metadata && typeof body.metadata === 'object' ? JSON.stringify(body.metadata) : null
    const result = db.prepare(`
      INSERT INTO messages (conversation_id, from_agent, to_agent, content, message_type, metadata, workspace_id)
      VALUES (?, ?, ?, ?, 'text', ?, ?)
    `).run(conversationId, from, to, content, metadata, workspaceId)

    const messageId = Number(result.lastInsertRowid)
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as Record<string, unknown>

    eventBus.broadcast('chat.message', { workspace_id: workspaceId, ...row })

    db_helpers.logActivity(
      'board_message', 'message', messageId, from,
      `Posted to ${conversationId}${to ? ` (to ${to})` : ''}`,
      { conversation_id: conversationId, to },
      workspaceId,
    )

    if (to) {
      db_helpers.createNotification(
        to, 'chat_message', `Board message from ${from}`,
        content.substring(0, 200), 'message', messageId, workspaceId,
      )
    }

    return NextResponse.json({ ok: true, message: row }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'Board post error')
    return NextResponse.json({ error: 'Failed to post board message' }, { status: 500 })
  }
}
