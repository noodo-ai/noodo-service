import { TrendsCollector } from './trends/collector.js'
import { registerTrendRoutes } from './http/trends.js'
import { registerAuthRoutes, tokenHash } from './http/auth.js'
import { registerConversationRoutes } from './http/conversations.js'
import { registerResourceRoutes } from './http/resources.js'
import { RateLimits } from './http/rate-limits.js'
import Fastify, { LogController } from 'fastify'
import cookie from '@fastify/cookie'
import { Store } from './db/store.js'
import type { Config } from './config.js'
import { publicError, ServiceError } from './contracts.js'
import { InfoClient } from './hyperliquid/client.js'
import { BusinessTools } from './hyperliquid/tools.js'
import { ClaudeProvider, type Provider } from './ai/provider.js'
import { Runner } from './ai/runner.js'
export async function createServer(
  config: Config,
  dependencies: {
    store?: Store
    provider?: Provider
    tools?: BusinessTools
    logger?: boolean
  } = {},
) {
  const app = Fastify({
    logger:
      dependencies.logger === false
        ? false
        : {
            level: 'info',
            redact: [
              'req.headers.cookie',
              'req.headers.authorization',
              'password',
              'ANTHROPIC_API_KEY',
            ],
          },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 20000,
    trustProxy: false,
  })
  const store = dependencies.store ?? new Store(config.DATABASE_PATH)
  store.recover()
  const info = new InfoClient(config.HYPERLIQUID_WEIGHT_PER_MINUTE)
  const trends = new TrendsCollector(store, info)
  const runner = new Runner(
    store,
    dependencies.tools ??
      new BusinessTools(
        info,
        config.SUPPORTED_ACCOUNT_MODES ? ['disabled'] : [],
      ),
    dependencies.provider ??
      new ClaudeProvider(
        config.CLAUDE_MODEL,
        config.ANTHROPIC_API_KEY,
        config.ANTHROPIC_REQUESTS_PER_MINUTE,
      ),
    (metrics) => app.log.info(metrics, 'Run settled'),
  )
  const limits = new RateLimits(),
    allowed = new Set(config.ALLOWED_ORIGINS.split(',').map((v) => v.trim())),
    active = new Set<AbortController>()
  await app.register(cookie)
  app.decorateRequest('userId', '')
  app.addHook('onRequest', async (req) => {
    if (
      ['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method) &&
      !allowed.has(req.headers.origin ?? '')
    )
      throw new ServiceError(
        'originForbidden',
        'A permitted Origin header is required',
        403,
      )
    if (
      req.url.startsWith('/v1/') &&
      req.url.split('?')[0] !== '/v1/auth/login'
    ) {
      const token = req.cookies.noodo_session
      const session = token
        ? (store.sql
            .prepare('SELECT userId FROM sessions WHERE id=? AND expiresAt>?')
            .get(tokenHash(token), Date.now()) as
            { userId: string } | undefined)
        : undefined
      if (!session)
        throw new ServiceError(
          'unauthenticated',
          'Sign in with your invited account',
          401,
        )
      req.userId = session.userId
    }
  })
  app.setErrorHandler((e, req, reply) => {
    const error = publicError(e)
    if (error.status === 429) reply.header('Retry-After', '60')
    app.log.warn({ code: error.code, requestId: req.id }, 'Request rejected')
    reply.code(error.status).send({ error: error.toJSON() })
  })
  app.get('/health', async () => {
    store.sql.prepare('SELECT 1').get()
    return { status: 'ok', database: 'ok' }
  })
  await registerAuthRoutes(app, store, config, limits)
  registerConversationRoutes(app, store, config, limits, runner, active)
  registerResourceRoutes(app, store, limits)
  registerTrendRoutes(app, trends)
  let trendTimer: ReturnType<typeof setInterval> | undefined
  app.addHook('onListen', async () => {
    const collect = () => {
      void trends
        .refresh()
        .catch(() =>
          app.log.warn(
            { code: 'trendsCollectionFailed' },
            'Trends collection failed',
          ),
        )
    }
    collect()
    trendTimer = setInterval(collect, 60_000)
    trendTimer.unref()
  })
  const prune = setInterval(() => {
    try {
      store.prune()
    } catch {
      app.log.warn({ code: 'retentionFailed' }, 'Retention cleanup failed')
    }
  }, 3600000)
  prune.unref()
  app.addHook('preClose', async () => {
    clearInterval(trendTimer)
    await trends.stop()
    for (const c of active) c.abort()
  })
  app.addHook('onClose', async () => {
    clearInterval(prune)
    if (!dependencies.store) store.close()
  })
  return app
}
declare module 'fastify' {
  interface FastifyRequest {
    userId: string
  }
}
