import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { listVentures } from '@/lib/desk'

// Operations Overview snapshot: portfolio revenue velocity, work-queue counts,
// ventures ranked by action required, today's due tasks and pending reviews.
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const db = getDatabase()
  const workspaceId = auth.user.workspace_id ?? 1

  const ventures = listVentures(db, workspaceId)
  const activeVentures = ventures.filter((v) => v.status === 'active')
  const revenueCurrent = activeVentures.reduce((sum, v) => sum + v.revenue_current, 0)
  const revenueTarget = activeVentures.reduce((sum, v) => sum + (v.revenue_target ?? 0), 0)

  const dayStart = Math.floor(Date.now() / 1000 / 86400) * 86400
  const dayEnd = dayStart + 86400

  const openTasks = (db.prepare(`
    SELECT COUNT(*) AS c FROM tasks WHERE workspace_id = ? AND status NOT IN ('done')
  `).get(workspaceId) as { c: number }).c

  const dueToday = db.prepare(`
    SELECT id, title, status, assigned_to, due_date, project_id FROM tasks
    WHERE workspace_id = ? AND status NOT IN ('done') AND due_date >= ? AND due_date < ?
    ORDER BY due_date ASC LIMIT 50
  `).all(workspaceId, dayStart, dayEnd)

  const pendingReviews = db.prepare(`
    SELECT r.id, r.title, r.status, r.agent_name, r.project_id, r.created_at, p.name AS project_name
    FROM review_deliverables r LEFT JOIN projects p ON p.id = r.project_id
    WHERE r.workspace_id = ? AND r.status IN ('pending', 'changes_requested')
    ORDER BY r.created_at DESC LIMIT 20
  `).all(workspaceId)

  const venturesRanked = [...ventures].sort(
    (a, b) => (b.open_tasks + b.pending_reviews) - (a.open_tasks + a.pending_reviews) || a.name.localeCompare(b.name),
  )

  return NextResponse.json({
    revenue: { current: revenueCurrent, target: revenueTarget },
    counts: {
      active_ventures: activeVentures.length,
      open_tasks: openTasks,
      due_today: dueToday.length,
      pending_reviews: pendingReviews.length,
    },
    ventures_ranked: venturesRanked,
    due_today: dueToday,
    pending_reviews: pendingReviews,
  })
}
