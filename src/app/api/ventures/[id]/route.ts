import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, db_helpers } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { listVentures } from '@/lib/desk'

const PROJECT_FIELDS = new Set(['name', 'description', 'category', 'revenue_target', 'status'])

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { id } = await params
  const db = getDatabase()
  const workspaceId = auth.user.workspace_id ?? 1
  const venture = listVentures(db, workspaceId).find((v) => v.id === Number(id))
  if (!venture) return NextResponse.json({ error: 'Venture not found' }, { status: 404 })
  return NextResponse.json({ venture })
}

// PATCH updates venture fields. `analytics` is merged key-by-key so external
// agents can bump telemetry chips without clobbering each other; pass a null
// value to delete a chip.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const { id } = await params
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const project = db.prepare('SELECT * FROM projects WHERE id = ? AND workspace_id = ?').get(Number(id), workspaceId) as Record<string, unknown> | undefined
    if (!project) return NextResponse.json({ error: 'Venture not found' }, { status: 404 })

    const body = await request.json()
    const sets: string[] = []
    const values: unknown[] = []

    for (const field of PROJECT_FIELDS) {
      if (!(field in body)) continue
      if (field === 'name') {
        const name = String(body.name ?? '').trim()
        if (!name || name.length > 120) return NextResponse.json({ error: '"name" must be 1-120 chars' }, { status: 400 })
        sets.push('name = ?'); values.push(name)
      } else if (field === 'revenue_target') {
        const v = body.revenue_target
        if (v != null && (!Number.isFinite(Number(v)) || Number(v) < 0)) {
          return NextResponse.json({ error: '"revenue_target" must be a non-negative number or null' }, { status: 400 })
        }
        sets.push('revenue_target = ?'); values.push(v == null ? null : Number(v))
      } else if (field === 'category' || field === 'description') {
        sets.push(`${field} = ?`); values.push(body[field] == null ? null : String(body[field]).slice(0, field === 'category' ? 40 : 4000))
      } else if (field === 'status') {
        if (!['active', 'paused', 'archived', 'completed'].includes(String(body.status))) {
          return NextResponse.json({ error: '"status" must be active|paused|archived|completed' }, { status: 400 })
        }
        sets.push('status = ?'); values.push(String(body.status))
      }
    }

    if ('analytics' in body) {
      if (body.analytics != null && (typeof body.analytics !== 'object' || Array.isArray(body.analytics))) {
        return NextResponse.json({ error: '"analytics" must be an object or null' }, { status: 400 })
      }
      let current: Record<string, unknown> = {}
      try { current = project.analytics ? JSON.parse(String(project.analytics)) : {} } catch { /* reset */ }
      if (body.analytics == null) {
        current = {}
      } else {
        for (const [k, v] of Object.entries(body.analytics)) {
          if (v === null) delete current[k]
          else current[String(k).slice(0, 80)] = v
        }
      }
      sets.push('analytics = ?'); values.push(JSON.stringify(current).slice(0, 16000))
    }

    if (sets.length === 0) return NextResponse.json({ error: 'No updatable fields provided' }, { status: 400 })

    sets.push('updated_at = unixepoch()')
    values.push(Number(id), workspaceId)
    db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ?`).run(...values)

    const actor = auth.user.display_name || auth.user.username || 'system'
    db_helpers.logActivity('venture_updated', 'project', Number(id), actor, `Updated venture: ${project.name}`, { fields: Object.keys(body) }, workspaceId)

    const venture = listVentures(db, workspaceId).find((v) => v.id === Number(id))
    return NextResponse.json({ ok: true, venture })
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/ventures/[id] error')
    return NextResponse.json({ error: 'Failed to update venture' }, { status: 500 })
  }
}
