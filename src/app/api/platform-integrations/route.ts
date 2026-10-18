import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { encryptSecret, maskSecret } from '@/lib/secret-store'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { logAuditEvent } from '@/lib/db'

const PLATFORMS = new Set(['clickbank', 'custom_http', 'manual'])

function latestMetrics(db: ReturnType<typeof getDatabase>, integrationId: number) {
  return db.prepare(`
    SELECT m.metric, m.value, m.currency, m.captured_at, m.source
    FROM metric_snapshots m
    JOIN (
      SELECT metric, MAX(captured_at) as max_captured FROM metric_snapshots
      WHERE integration_id = ? GROUP BY metric
    ) latest ON latest.metric = m.metric AND latest.max_captured = m.captured_at
    WHERE m.integration_id = ?
  `).all(integrationId, integrationId)
}

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const db = getDatabase()
  const workspaceId = auth.user.workspace_id ?? 1
  const { searchParams } = new URL(request.url)
  const projectId = searchParams.get('project_id')

  const rows = projectId
    ? db.prepare(`SELECT pi.*, p.name as project_name FROM platform_integrations pi LEFT JOIN projects p ON p.id = pi.project_id WHERE pi.workspace_id = ? AND pi.project_id = ? ORDER BY pi.created_at DESC`).all(workspaceId, Number(projectId))
    : db.prepare(`SELECT pi.*, p.name as project_name FROM platform_integrations pi LEFT JOIN projects p ON p.id = pi.project_id WHERE pi.workspace_id = ? ORDER BY pi.created_at DESC`).all(workspaceId)

  const integrations = (rows as Record<string, unknown>[]).map(row => ({
    ...row,
    credential_enc: undefined,
    has_credential: Boolean(row.credential_enc),
    metrics: latestMetrics(db, row.id as number),
  }))

  return NextResponse.json({ integrations })
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
    const platform = String(body.platform ?? '').trim()
    if (!name || name.length > 120) return NextResponse.json({ error: '"name" is required (max 120 chars)' }, { status: 400 })
    if (!PLATFORMS.has(platform)) return NextResponse.json({ error: `"platform" must be one of: ${[...PLATFORMS].join(', ')}` }, { status: 400 })

    const projectId = body.project_id ? Number(body.project_id) : null
    if (projectId) {
      const project = db.prepare('SELECT id FROM projects WHERE id = ? AND workspace_id = ?').get(projectId, workspaceId)
      if (!project) return NextResponse.json({ error: 'Project not found in this workspace' }, { status: 404 })
    }

    const credential = typeof body.credential === 'string' && body.credential.trim() ? body.credential.trim() : null
    const credentialEnc = credential ? encryptSecret(credential) : null

    let config: string | null = null
    if (body.config !== undefined && body.config !== null) {
      if (typeof body.config !== 'object') return NextResponse.json({ error: '"config" must be an object' }, { status: 400 })
      config = JSON.stringify(body.config)
    }

    const result = db.prepare(`
      INSERT INTO platform_integrations (workspace_id, project_id, platform, name, credential_enc, config, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(workspaceId, projectId, platform, name, credentialEnc, config, body.enabled === false ? 0 : 1)

    const id = Number(result.lastInsertRowid)
    logAuditEvent({
      action: 'platform_integration_created', actor: auth.user.username, actor_id: auth.user.id,
      target_type: 'platform_integration', target_id: id,
      detail: JSON.stringify({ platform, name, has_credential: Boolean(credentialEnc) }),
    })

    return NextResponse.json({
      ok: true,
      integration: { id, platform, name, project_id: projectId, enabled: true, has_credential: Boolean(credentialEnc), credential_preview: credential ? maskSecret(credential) : null },
    }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'Platform integration create error')
    return NextResponse.json({ error: 'Failed to create integration' }, { status: 500 })
  }
}
