import type { FastifyInstance } from 'fastify'
import type { TrendsCollector } from '../trends/collector.js'

export function registerTrendRoutes(
  app: FastifyInstance,
  trends: TrendsCollector,
): void {
  // Authentication is enforced by the shared /v1 hook. Reads never trigger upstream work.
  app.get('/v1/trends', async (_req, reply) =>
    reply.header('Cache-Control', 'no-store').send(trends.read()),
  )
}
