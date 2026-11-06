import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, db_helpers } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { eventBus } from '@/lib/event-bus'
import { logger } from '@/lib/logger'

const ACTIONS: Record<string, string> = {
  approve: 'approved',
  request_changes: 'changes_requested',
  reject: 'rejected',
  resubmit: 'pending',
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { id } = await params
  const db = getDatabase()
  const workspaceId = auth.user.workspace_id ?? 1
  const item = db.prepare(`
    SELECT r.*, p.name AS project_name FROM review_deliverables r
    LEFT JOIN projects p ON p.id = r.project_id WHERE r.id = ? AND r.workspace_id = ?
  `).get(Number(id), workspaceId)
  if (!item) return NextResponse.json({ error: 'Review item not found' }, { status: 404 })
  return NextResponse.json({ item })
}

// PATCH decides the review: action=approve|request_changes|reject, optional
// `feedback` note appended to the feedback trace. Agents resubmit with
// action=resubmit after addressing feedback.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const { id } = await params
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const item = db.prepare('SELECT * FROM review_deliverables WHERE id = ? AND workspace_id = ?').get(Number(id), workspaceId) as Record<string, unknown> | undefined
    if (!item) return NextResponse.json({ error: 'Review item not found' }, { status: 404 })

    const body = await request.json()
    const action = String(body.action ?? '')
    const nextStatus = ACTIONS[action]
    if (!nextStatus) return NextResponse.json({ error: '"action" must be approve|request_changes|reject|resubmit' }, { status: 400 })

    const actor = auth.user.display_name || auth.user.username || 'system'

    let feedback: Array<{ actor: string; note: string; at: number }> = []
    try { feedback = item.feedback ? JSON.parse(String(item.feedback)) : [] } catch { feedback = [] }
    if (body.feedback != null && String(body.feedback).trim()) {
      feedback.push({ actor, note: String(body.feedback).slice(0, 4000), at: Math.floor(Date.now() / 1000) })
    }

    const sets = ['status = ?', 'feedback = ?', 'updated_at = unixepoch()']
    const values: unknown[] = [nextStatus, JSON.stringify(feedback)]
    if (action !== 'resubmit') { sets.push('reviewed_by = ?', 'reviewed_at = unixepoch()'); values.push(actor) }
    if (action === 'resubmit' && body.delivered != null) { sets.push('delivered = ?'); values.push(String(body.delivered).slice(0, 4000)) }
    if (action === 'resubmit' && body.evidence != null) { sets.push('evidence = ?'); values.push(String(body.evidence).slice(0, 60000)) }
    values.push(Number(id), workspaceId)

    db.prepare(`UPDATE review_deliverables SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ?`).run(...values)

    const verb = { approved: 'approved', changes_requested: 'requested changes on', rejected: 'rejected', pending: 'resubmitted' }[nextStatus]
    db_helpers.logActivity('review_decision', 'review', Number(id), actor, `${actor} ${verb}: ${item.title}`, { status: nextStatus }, workspaceId)
    eventBus.broadcast('review.decided', { workspace_id: workspaceId, id: Number(id), status: nextStatus, reviewer: actor })

    // Notify the submitting agent's board user when a human decides; the agent
    // picks up feedback on its next poll of GET /api/review-queue.
    const agentName = item.agent_name as string | null
    if (agentName && agentName !== actor && nextStatus !== 'pending') {
      db_helpers.createNotification(
        agentName, 'review_decision', `Review ${nextStatus.replace('_', ' ')}: ${item.title}`,
        String(body.feedback ?? '').slice(0, 200), 'review', Number(id), workspaceId,
      )
    }

    const updated = db.prepare('SELECT * FROM review_deliverables WHERE id = ?').get(Number(id))
    return NextResponse.json({ ok: true, item: updated })
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/review-queue/[id] error')
    return NextResponse.json({ error: 'Failed to update review item' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { id } = await params
  const db = getDatabase()
  const workspaceId = auth.user.workspace_id ?? 1
  const result = db.prepare('DELETE FROM review_deliverables WHERE id = ? AND workspace_id = ?').run(Number(id), workspaceId)
  if (result.changes === 0) return NextResponse.json({ error: 'Review item not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
