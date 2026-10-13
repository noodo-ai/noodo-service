import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Config } from '../config.js'
import type { Store } from '../db/store.js'
import type { Runner } from '../ai/runner.js'
import type { RateLimits } from './rate-limits.js'
import {
  createSchema,
  addressUpdateSchema,
  messageSchema,
} from '../contracts.js'

export function registerConversationRoutes(
  app: FastifyInstance,
  store: Store,
  config: Config,
  limits: RateLimits,
  runner: Runner,
  active: Set<AbortController>,
): void {
  app.post('/v1/conversations', async (req) => {
    const input = createSchema.parse(req.body ?? {})
    return store.create(req.userId, input.observedAddress)
  })
  app.get('/v1/conversations', async (req) => ({
    conversations: store.sql
      .prepare(
        'SELECT * FROM conversations WHERE ownerId=? ORDER BY updatedAt DESC,id DESC LIMIT 100',
      )
      .all(req.userId),
  }))
  app.get<{ Params: { id: string } }>('/v1/conversations/:id', async (req) => {
    const conversation = store.owner(req.params.id, req.userId)
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: z.string().optional(),
      })
      .parse(req.query)
    const history = store.history(conversation.id, query.limit, query.cursor)
    const ids = [...new Set(history.messages.map((m) => m.runId))]
    const runs = ids.map((id) => serializeRun(store.run(id, req.userId)))
    const activeRun = store.sql
      .prepare(
        "SELECT id FROM runs WHERE conversationId=? AND status='running'",
      )
      .get(conversation.id) as { id: string } | undefined
    return {
      ...conversation,
      ...history,
      runs,
      activeRunId: activeRun?.id ?? null,
    }
  })
  app.patch<{ Params: { id: string } }>(
    '/v1/conversations/:id',
    async (req) => {
      const p = addressUpdateSchema.parse(req.body)
      return store.updateAddress(
        req.params.id,
        req.userId,
        p.observedAddress,
        p.expectedAddressVersion,
      )
    },
  )
  app.get<{ Params: { id: string } }>('/v1/runs/:id', async (req) =>
    serializeRun(store.run(req.params.id, req.userId)),
  )
  app.post<{ Params: { id: string } }>(
    '/v1/conversations/:id/messages',
    async (req, reply) => {
      store.owner(req.params.id, req.userId)
      const payload = messageSchema.parse(req.body)
      // Existing IDs bypass all new-request checks, including rate and address checks.
      const existing = store.sql
        .prepare(
          'SELECT id FROM runs WHERE conversationId=? AND clientRequestId=?',
        )
        .get(req.params.id, payload.clientRequestId)
      if (!existing) limits.take(`chat:${req.userId}`, 6)
      const accepted = store.accept(req.params.id, req.userId, payload, config)
      if (accepted.duplicate)
        return {
          runId: accepted.run.id,
          status: accepted.run.status,
          resultUrl: `/v1/runs/${accepted.run.id}`,
        }
      reply.hijack()
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'X-Run-Id': accepted.run.id,
      })
      const controller = new AbortController()
      active.add(controller)
      const abort = () => {
        if (!reply.raw.writableEnded) controller.abort()
      }
      reply.raw.on('close', abort)
      const emit = (event: string, data: Record<string, unknown>) => {
        if (!reply.raw.destroyed && !reply.raw.writableEnded)
          reply.raw.write(
            `event: ${event}\ndata: ${JSON.stringify({ ...data, runId: accepted.run.id })}\n\n`,
          )
      }
      const heartbeat = setInterval(() => {
        if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n')
      }, 15000)
      try {
        await runner.execute(accepted.run, controller.signal, emit)
      } finally {
        clearInterval(heartbeat)
        reply.raw.off('close', abort)
        active.delete(controller)
        if (!reply.raw.destroyed) reply.raw.end()
      }
    },
  )
}

function serializeRun(run: ReturnType<Store['run']>) {
  return {
    id: run.id,
    status: run.status,
    observedAddress: run.observedAddress,
    addressVersion: run.addressVersion,
    marketScope: run.marketScope,
    createdAt: run.createdAt,
    settledAt: run.settledAt,
    result: run.result ? JSON.parse(run.result) : null,
    error: run.error ? JSON.parse(run.error) : null,
  }
}
