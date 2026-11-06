import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, logAuditEvent } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { encryptSecret } from '@/lib/secret-store'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'

interface Params {
  params: Promise<{ id: string }>
}

function getIntegration(db: ReturnType<typeof getDatabase>, id: number, workspaceId: number) {
  return db.prepare('SELECT * FROM platform_integrations WHERE id = ? AND workspace_id = ?').get(id, workspaceId) as Record<string, unknown> | undefined
}

export async function GET(request: NextRequest, { params }: Params) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const db = getDatabase()
  const { id } = await params
  const integration = getIntegration(db, Number(id), auth.user.workspace_id ?? 1)
  if (!integration) return NextResponse.json({ error: 'Integration not found' }, { status: 404 })

  const metrics = db.prepare(`
    SELECT metric, value, currency, captured_at, source FROM metric_snapshots
    WHERE integration_id = ? ORDER BY captured_at DESC LIMIT 200
  `).all(Number(id))

  return NextResponse.json({
    integration: { ...integration, credential_enc: undefined, has_credential: Boolean(integration.credential_enc) },
    metrics,
  })
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const { id } = await params
    const integration = getIntegration(db, Number(id), workspaceId)
    if (!integration) return NextResponse.json({ error: 'Integration not found' }, { status: 404 })

    const body = await request.json()
    const fields: string[] = []
    const values: unknown[] = []

    if (body.name !== undefined) {
      const name = String(body.name).trim()
      if (!name || name.length > 120) return NextResponse.json({ error: 'Invalid name' }, { status: 400 })
      fields.push('name = ?'); values.push(name)
    }
    if (body.enabled !== undefined) { fields.push('enabled = ?'); values.push(body.enabled ? 1 : 0) }
    if (body.project_id !== undefined) {
      const projectId = body.project_id ? Number(body.project_id) : null
      if (projectId) {
        const project = db.prepare('SELECT id FROM projects WHERE id = ? AND workspace_id = ?').get(projectId, workspaceId)
        if (!project) return NextResponse.json({ error: 'Project not found in this workspace' }, { status: 404 })
      }
      fields.push('project_id = ?'); values.push(projectId)
    }
    if (body.config !== undefined) {
      if (body.config !== null && typeof body.config !== 'object') return NextResponse.json({ error: '"config" must be an object or null' }, { status: 400 })
      fields.push('config = ?'); values.push(body.config ? JSON.stringify(body.config) : null)
    }
    if (typeof body.credential === 'string' && body.credential.trim()) {
      fields.push('credential_enc = ?'); values.push(encryptSecret(body.credential.trim()))
    }

    if (fields.length === 0) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })

    values.push(Number(id))
    db.prepare(`UPDATE platform_integrations SET ${fields.join(', ')}, updated_at = unixepoch() WHERE id = ?`).run(...values)

    logAuditEvent({
      action: 'platform_integration_updated', actor: auth.user.username, actor_id: auth.user.id,
      target_type: 'platform_integration', target_id: Number(id),
      detail: JSON.stringify({ fields }),
    })

    return NextResponse.json({ ok: true })
  } catch (error) {
    logger.error({ err: error }, 'Platform integration update error')
    return NextResponse.json({ error: 'Failed to update integration' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  const db = getDatabase()
  const { id } = await params
  const integration = getIntegration(db, Number(id), auth.user.workspace_id ?? 1)
  if (!integration) return NextResponse.json({ error: 'Integration not found' }, { status: 404 })

  db.prepare('DELETE FROM metric_snapshots WHERE integration_id = ?').run(Number(id))
  db.prepare('DELETE FROM platform_integrations WHERE id = ?').run(Number(id))

  logAuditEvent({
    action: 'platform_integration_deleted', actor: auth.user.username, actor_id: auth.user.id,
    target_type: 'platform_integration', target_id: Number(id),
    detail: JSON.stringify({ name: integration.name, platform: integration.platform }),
  })

  return NextResponse.json({ ok: true })
}
