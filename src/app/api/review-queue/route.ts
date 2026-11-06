import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, db_helpers } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { eventBus } from '@/lib/event-bus'
import { logger } from '@/lib/logger'

// Sign-off review queue: agents (or humans) submit deliverables with expected
// vs actual summaries and raw evidence; a human approves, requests changes or
// rejects from the Review Queue panel. Statuses:
//   pending -> approved | changes_requested | rejected
//   changes_requested -> pending (agent resubmits via POST or PATCH)
// Agents poll GET /api/review-queue?status=changes_requested for feedback.

const STATUSES = new Set(['pending', 'changes_requested', 'approved', 'rejected'])

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const db = getDatabase()
  const workspaceId = auth.user.workspace_id ?? 1
  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status')
  const projectId = searchParams.get('project_id')
  const limit = Math.min(Number(searchParams.get('limit') || 100), 500)

  const where = ['workspace_id = ?']
  const args: unknown[] = [workspaceId]
  if (status && STATUSES.has(status)) { where.push('status = ?'); args.push(status) }
  if (projectId) { where.push('project_id = ?'); args.push(Number(projectId)) }

  const items = db.prepare(`
    SELECT r.*, p.name AS project_name FROM review_deliverables r
    LEFT JOIN projects p ON p.id = r.project_id
    WHERE ${where.join(' AND ')}
    ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'changes_requested' THEN 1 ELSE 2 END, r.created_at DESC
    LIMIT ?
  `).all(...args, limit)

  const counts = db.prepare(`
    SELECT status, COUNT(*) AS c FROM review_deliverables WHERE workspace_id = ? GROUP BY status
  `).all(workspaceId)

  return NextResponse.json({ items, counts })
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

    const title = String(body.title ?? '').trim()
    if (!title || title.length > 200) return NextResponse.json({ error: '"title" is required (max 200 chars)' }, { status: 400 })

    const projectId = body.project_id != null ? Number(body.project_id) : null
    if (projectId != null) {
      const project = db.prepare('SELECT 1 FROM projects WHERE id = ? AND workspace_id = ?').get(projectId, workspaceId)
      if (!project) return NextResponse.json({ error: 'project_id not found in workspace' }, { status: 400 })
    }

    const clip = (v: unknown, max: number) => (v == null ? null : String(v).slice(0, max))
    const actor = auth.user.display_name || auth.user.username || 'system'
    const feedback = body.feedback
      ? JSON.stringify([{ actor, note: String(body.feedback).slice(0, 4000), at: Math.floor(Date.now() / 1000) }])
      : '[]'

    const result = db.prepare(`
      INSERT INTO review_deliverables
        (workspace_id, project_id, title, summary, expected_target, delivered, evidence, status, agent_name, feedback, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(
      workspaceId, projectId, title,
      clip(body.summary, 4000), clip(body.expected_target, 4000),
      clip(body.delivered, 4000), clip(body.evidence, 60000),
      clip(body.agent_name ?? actor, 120), feedback, actor,
    )

    const id = Number(result.lastInsertRowid)
    const item = db.prepare('SELECT * FROM review_deliverables WHERE id = ?').get(id)

    db_helpers.logActivity('review_submitted', 'review', id, actor, `Submitted deliverable for review: ${title}`, { project_id: projectId }, workspaceId)
    eventBus.broadcast('review.submitted', { workspace_id: workspaceId, id, title, agent_name: (item as Record<string, unknown>)?.agent_name })

    return NextResponse.json({ ok: true, item }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/review-queue error')
    return NextResponse.json({ error: 'Failed to submit deliverable' }, { status: 500 })
  }
}
