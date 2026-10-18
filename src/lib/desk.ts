import type { getDatabase } from '@/lib/db'

// Shared reads for the "operations desk" layer: ventures (projects with a
// category, revenue target and telemetry chips) and the sign-off review queue.
// Telemetry chips come from two sources merged in order: latest
// metric_snapshots per platform integration bound to the project, then the
// project's `analytics` JSON (agents PATCH it directly).

type Db = ReturnType<typeof getDatabase>

export interface VentureRow {
  id: number
  name: string
  slug: string
  description: string | null
  status: string
  category: string | null
  revenue_target: number | null
  analytics: string | null
  created_at: number
}

export interface Venture extends Omit<VentureRow, 'analytics'> {
  analytics: Record<string, unknown>
  revenue_current: number
  currency: string
  open_tasks: number
  pending_reviews: number
  metrics: Array<{ metric: string; value: number; currency: string | null }>
}

function parseAnalytics(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function listVentures(db: Db, workspaceId: number): Venture[] {
  const projects = db.prepare(`
    SELECT id, name, slug, description, status, category, revenue_target, analytics, created_at
    FROM projects WHERE workspace_id = ? ORDER BY name
  `).all(workspaceId) as VentureRow[]

  const openTasks = new Map<number, number>(
    (db.prepare(`
      SELECT project_id, COUNT(*) AS c FROM tasks
      WHERE workspace_id = ? AND project_id IS NOT NULL AND status NOT IN ('done')
      GROUP BY project_id
    `).all(workspaceId) as Array<{ project_id: number; c: number }>).map((r) => [r.project_id, r.c]),
  )
  const pendingReviews = new Map<number, number>(
    (db.prepare(`
      SELECT project_id, COUNT(*) AS c FROM review_deliverables
      WHERE workspace_id = ? AND project_id IS NOT NULL AND status IN ('pending', 'changes_requested')
      GROUP BY project_id
    `).all(workspaceId) as Array<{ project_id: number; c: number }>).map((r) => [r.project_id, r.c]),
  )

  const latestMetricRows = db.prepare(`
    SELECT pi.project_id, m.metric, m.value, m.currency
    FROM metric_snapshots m
    JOIN platform_integrations pi ON pi.id = m.integration_id
    JOIN (
      SELECT integration_id, metric, MAX(id) AS max_id
      FROM metric_snapshots GROUP BY integration_id, metric
    ) latest ON latest.max_id = m.id
    WHERE pi.workspace_id = ? AND pi.project_id IS NOT NULL AND pi.enabled = 1
  `).all(workspaceId) as Array<{ project_id: number; metric: string; value: number; currency: string | null }>

  const metricsByProject = new Map<number, Array<{ metric: string; value: number; currency: string | null }>>()
  for (const row of latestMetricRows) {
    const list = metricsByProject.get(row.project_id) ?? []
    list.push(row)
    metricsByProject.set(row.project_id, list)
  }

  return projects.map((p) => {
    const metrics = metricsByProject.get(p.id) ?? []
    const revenueMetric = metrics.find((m) => m.metric === 'revenue')
    const analytics = parseAnalytics(p.analytics)
    return {
      ...p,
      analytics,
      revenue_current: revenueMetric?.value ?? (typeof analytics.revenue === 'number' ? analytics.revenue : 0),
      currency: revenueMetric?.currency ?? 'USD',
      open_tasks: openTasks.get(p.id) ?? 0,
      pending_reviews: pendingReviews.get(p.id) ?? 0,
      metrics,
    }
  })
}
