import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { runPlatformSync } from '@/lib/platform-sync'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'

interface Params {
  params: Promise<{ id: string }>
}

export async function POST(request: NextRequest, { params }: Params) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const db = getDatabase()
    const { id } = await params
    const integration = db.prepare(
      'SELECT id, platform, credential_enc, config, enabled FROM platform_integrations WHERE id = ? AND workspace_id = ?'
    ).get(Number(id), auth.user.workspace_id ?? 1) as { id: number; platform: string; credential_enc: string | null; config: string | null; enabled: number } | undefined

    if (!integration) return NextResponse.json({ error: 'Integration not found' }, { status: 404 })
    if (!integration.enabled) return NextResponse.json({ error: 'Integration is disabled' }, { status: 400 })

    const result = await runPlatformSync(integration)
    const now = Math.floor(Date.now() / 1000)

    if (result.ok) {
      const insert = db.prepare(`
        INSERT INTO metric_snapshots (integration_id, metric, value, currency, source, raw)
        VALUES (?, ?, ?, ?, 'sync', ?)
      `)
      const tx = db.transaction(() => {
        for (const m of result.metrics) {
          insert.run(integration.id, m.metric, m.value, m.currency ?? null, result.raw ? JSON.stringify(result.raw).slice(0, 8000) : null)
        }
      })
      tx()

      db.prepare(`UPDATE platform_integrations SET last_sync_at = ?, last_sync_status = 'ok', last_error = NULL, updated_at = ? WHERE id = ?`)
        .run(now, now, integration.id)
    } else {
      db.prepare(`UPDATE platform_integrations SET last_sync_at = ?, last_sync_status = 'error', last_error = ?, updated_at = ? WHERE id = ?`)
        .run(now, (result.error || 'sync failed').slice(0, 500), now, integration.id)
    }

    return NextResponse.json({ ok: result.ok, metrics: result.metrics, error: result.error })
  } catch (error) {
    logger.error({ err: error }, 'Platform sync error')
    return NextResponse.json({ error: 'Sync failed' }, { status: 500 })
  }
}
