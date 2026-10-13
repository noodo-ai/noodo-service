import type { FastifyInstance } from 'fastify'
import argon2 from 'argon2'
import { createHash, randomBytes } from 'node:crypto'
import type { Config } from '../config.js'
import type { Store } from '../db/store.js'
import { loginSchema, ServiceError } from '../contracts.js'
import type { RateLimits } from './rate-limits.js'

export const tokenHash = (value: string): string =>
  createHash('sha256').update(value).digest('hex')

export async function registerAuthRoutes(
  app: FastifyInstance,
  store: Store,
  config: Config,
  limits: RateLimits,
): Promise<void> {
  const dummyHash = await argon2.hash(randomBytes(32), {
    type: argon2.argon2id,
  })
  app.get('/v1/auth/me', async (req) => {
    const user = store.sql
      .prepare('SELECT id,username FROM users WHERE id=?')
      .get(req.userId)
    return { user }
  })
  app.post('/v1/auth/login', async (req, reply) => {
    limits.take(`login-ip:${req.ip}`, 10, 15 * 60000)
    const input = loginSchema.parse(req.body)
    limits.take(`login-account:${tokenHash(input.username)}`, 10, 15 * 60000)
    const user = store.user(input.username)
    if (
      !(await argon2.verify(user?.passwordHash ?? dummyHash, input.password)) ||
      !user
    )
      throw new ServiceError(
        'invalidCredentials',
        'Username or password is incorrect',
        401,
      )
    const token = randomBytes(32).toString('base64url'),
      expires = Date.now() + 7 * 86400000
    store.sql.transaction(() => {
      if (req.cookies.noodo_session)
        store.sql
          .prepare('DELETE FROM sessions WHERE id=?')
          .run(tokenHash(req.cookies.noodo_session))
      store.sql
        .prepare('INSERT INTO sessions VALUES(?,?,?)')
        .run(tokenHash(token), user.id, expires)
    })()
    reply.setCookie('noodo_session', token, {
      path: '/',
      httpOnly: true,
      secure: config.COOKIE_SECURE === 'true',
      sameSite: 'lax',
      expires: new Date(expires),
    })
    return { user: { id: user.id, username: user.username } }
  })
  app.post('/v1/auth/logout', async (req, reply) => {
    if (req.cookies.noodo_session)
      store.sql
        .prepare('DELETE FROM sessions WHERE id=?')
        .run(tokenHash(req.cookies.noodo_session))
    reply.clearCookie('noodo_session', { path: '/' })
    return { ok: true }
  })
}
