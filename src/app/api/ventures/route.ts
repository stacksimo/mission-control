import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, db_helpers, logAuditEvent } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { listVentures } from '@/lib/desk'

// Ventures are projects carrying a category, a monthly revenue target and an
// `analytics` JSON blob of agent-pushed telemetry chips. This is the desk
// layer's project API: the Ventures Hub and Operations Overview read through
// it, and external agents PATCH analytics to report telemetry.

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'venture'
}

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const db = getDatabase()
  const workspaceId = auth.user.workspace_id ?? 1
  return NextResponse.json({ ventures: listVentures(db, workspaceId) })
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

    const name = String(body.name ?? '').trim()
    if (!name || name.length > 120) {
      return NextResponse.json({ error: '"name" is required (max 120 chars)' }, { status: 400 })
    }
    const category = body.category ? String(body.category).trim().slice(0, 40) : null
    const description = body.description ? String(body.description).slice(0, 4000) : null
    const revenueTarget = body.revenue_target != null && body.revenue_target !== '' ? Number(body.revenue_target) : null
    if (revenueTarget != null && (!Number.isFinite(revenueTarget) || revenueTarget < 0)) {
      return NextResponse.json({ error: '"revenue_target" must be a non-negative number' }, { status: 400 })
    }
    const analytics = body.analytics && typeof body.analytics === 'object' && !Array.isArray(body.analytics)
      ? JSON.stringify(body.analytics).slice(0, 16000) : null

    let slug = slugify(body.slug ? String(body.slug) : name)
    const slugTaken = db.prepare('SELECT 1 FROM projects WHERE workspace_id = ? AND slug = ?')
    if (slugTaken.get(workspaceId, slug)) slug = `${slug}-${Date.now().toString(36)}`

    let prefix = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'VENT'
    const prefixTaken = db.prepare('SELECT 1 FROM projects WHERE workspace_id = ? AND ticket_prefix = ?')
    for (let i = 0; i < 10 && prefixTaken.get(workspaceId, prefix); i++) {
      prefix = `${prefix.slice(0, 6)}${i}`
    }

    const actor = auth.user.display_name || auth.user.username || 'system'
    const result = db.prepare(`
      INSERT INTO projects (workspace_id, name, slug, description, ticket_prefix, status, metadata, category, revenue_target, analytics)
      VALUES (?, ?, ?, ?, ?, 'active', '{}', ?, ?, ?)
    `).run(workspaceId, name, slug, description, prefix, category, revenueTarget, analytics)

    const id = Number(result.lastInsertRowid)
    db_helpers.logActivity('venture_created', 'project', id, actor, `Created venture: ${name}`, { category }, workspaceId)
    logAuditEvent({ action: 'venture_created', actor, target_type: 'project', target_id: id, workspace_id: workspaceId, detail: { name, category } })

    const venture = listVentures(db, workspaceId).find((v) => v.id === id)
    return NextResponse.json({ ok: true, venture }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/ventures error')
    return NextResponse.json({ error: 'Failed to create venture' }, { status: 500 })
  }
}
