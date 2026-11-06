import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, db_helpers } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'

interface Params {
  params: Promise<{ id: string }>
}

// GET /api/platform-integrations/[id]/metrics - metric history for an integration
export async function GET(request: NextRequest, { params }: Params) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const db = getDatabase()
  const { id } = await params
  const integration = db.prepare('SELECT id FROM platform_integrations WHERE id = ? AND workspace_id = ?')
    .get(Number(id), auth.user.workspace_id ?? 1)
  if (!integration) return NextResponse.json({ error: 'Integration not found' }, { status: 404 })

  const { searchParams } = new URL(request.url)
  const metric = searchParams.get('metric')
  const since = Number(searchParams.get('since') || 0)
  const limit = Math.min(Number(searchParams.get('limit') || 200), 1000)

  const rows = metric
    ? db.prepare(`SELECT metric, value, currency, source, captured_at FROM metric_snapshots WHERE integration_id = ? AND metric = ? AND captured_at > ? ORDER BY captured_at ASC LIMIT ?`).all(Number(id), metric, since, limit)
    : db.prepare(`SELECT metric, value, currency, source, captured_at FROM metric_snapshots WHERE integration_id = ? AND captured_at > ? ORDER BY captured_at ASC LIMIT ?`).all(Number(id), since, limit)

  return NextResponse.json({ metrics: rows })
}

// POST /api/platform-integrations/[id]/metrics - push a metric value (agents/scripts)
// Body: { metric, value, currency? }
export async function POST(request: NextRequest, { params }: Params) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const { id } = await params
    const integration = db.prepare('SELECT id, name FROM platform_integrations WHERE id = ? AND workspace_id = ?')
      .get(Number(id), workspaceId) as { id: number; name: string } | undefined
    if (!integration) return NextResponse.json({ error: 'Integration not found' }, { status: 404 })

    const body = await request.json()
    const metric = String(body.metric ?? '').trim()
    const value = Number(body.value)
    if (!metric || metric.length > 80) return NextResponse.json({ error: '"metric" is required (max 80 chars)' }, { status: 400 })
    if (!Number.isFinite(value)) return NextResponse.json({ error: '"value" must be a number' }, { status: 400 })
    const currency = typeof body.currency === 'string' ? body.currency.trim().slice(0, 8) : null

    const actor = auth.user.display_name || auth.user.username || 'system'
    const result = db.prepare(`
      INSERT INTO metric_snapshots (integration_id, metric, value, currency, source)
      VALUES (?, ?, ?, ?, ?)
    `).run(integration.id, metric, value, currency, `agent:${actor}`)

    db_helpers.logActivity(
      'metric_pushed', 'platform_integration', integration.id, actor,
      `Pushed metric ${metric}=${value}${currency ? ` ${currency}` : ''} to ${integration.name}`,
      { metric, value, currency },
      workspaceId,
    )

    return NextResponse.json({ ok: true, id: Number(result.lastInsertRowid) }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'Metric push error')
    return NextResponse.json({ error: 'Failed to record metric' }, { status: 500 })
  }
}
