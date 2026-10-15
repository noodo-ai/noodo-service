import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { Store } from '../db/store.js'
import { ResourceStore } from '../db/resources.js'
import { ServiceError } from '../contracts.js'
import {
  createResourceSchema,
  metadataSchema,
  fileMimes,
  topics,
  USER_RESOURCE_BYTES,
  RESOURCE_METADATA_BODY_LIMIT,
} from '../resources/contracts.js'
import type { RateLimits } from './rate-limits.js'

const categorySchema = z.object({ name: z.string().trim().min(1).max(60) })
const querySchema = z.object({
  scope: z.enum(['community', 'personal']).default('community'),
  search: z.string().trim().max(120).default(''),
  visibility: z.enum(['public', 'private']).optional(),
  categoryId: z
    .union([z.string().uuid(), z.literal('uncategorized')])
    .optional(),
  topic: z.enum(topics).optional(),
  format: z
    .enum(
      Object.keys(fileMimes) as [
        keyof typeof fileMimes,
        ...Array<keyof typeof fileMimes>,
      ],
    )
    .optional(),
  sort: z.enum(['latest', 'popular']).default('latest'),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
  limit: z.coerce.number().int().min(1).max(30).default(20),
})
export function registerResourceRoutes(
  app: FastifyInstance,
  store: Store,
  limits: RateLimits,
): void {
  app.addHook('onSend', async (req, reply) => {
    if (
      req.url.startsWith('/v1/resources') ||
      req.url.startsWith('/v1/resource-categories')
    )
      reply.header('Cache-Control', 'private, no-store')
  })
  const resources = new ResourceStore(store)
  app.get('/v1/resource-categories', async (req) => {
    const usage = store.sql
      .prepare(
        'SELECT coalesce(sum(bytes),0) AS bytes FROM resources WHERE ownerId=?',
      )
      .get(req.userId) as { bytes: number }
    return {
      categories: store.sql
        .prepare(
          'SELECT id,name FROM resource_categories WHERE ownerId=? ORDER BY name',
        )
        .all(req.userId),
      usedBytes: usage.bytes,
      limitBytes: USER_RESOURCE_BYTES,
    }
  })
  function ownerCategory(id: string, userId: string): void {
    if (
      !store.sql
        .prepare('SELECT id FROM resource_categories WHERE id=? AND ownerId=?')
        .get(id, userId)
    )
      throw new ServiceError('notFound', 'Category not found', 404)
  }
  function uniqueCategory(name: string, userId: string, id = ''): void {
    if (
      store.sql
        .prepare(
          'SELECT id FROM resource_categories WHERE ownerId=? AND name=? AND id!=?',
        )
        .get(userId, name, id)
    )
      throw new ServiceError(
        'categoryExists',
        'A category with this name already exists',
        409,
      )
  }
  app.post('/v1/resource-categories', async (req) => {
    limits.take(`resource-write:${req.userId}`, 30)
    const { name } = categorySchema.parse(req.body)
    uniqueCategory(name, req.userId)
    const count = store.sql
      .prepare('SELECT count(*) AS n FROM resource_categories WHERE ownerId=?')
      .get(req.userId) as { n: number }
    if (count.n >= 50)
      throw new ServiceError(
        'categoryLimit',
        'You can create up to 50 categories',
        409,
      )
    const id = randomUUID()
    store.sql
      .prepare('INSERT INTO resource_categories VALUES(?,?,?)')
      .run(id, req.userId, name)
    return { id, name }
  })
  app.patch<{ Params: { id: string } }>(
    '/v1/resource-categories/:id',
    async (req) => {
      limits.take(`resource-write:${req.userId}`, 30)
      ownerCategory(req.params.id, req.userId)
      const { name } = categorySchema.parse(req.body)
      uniqueCategory(name, req.userId, req.params.id)
      store.sql
        .prepare('UPDATE resource_categories SET name=? WHERE id=?')
        .run(name, req.params.id)
      return { id: req.params.id, name }
    },
  )
  app.delete<{ Params: { id: string } }>(
    '/v1/resource-categories/:id',
    async (req) => {
      limits.take(`resource-write:${req.userId}`, 30)
      ownerCategory(req.params.id, req.userId)
      store.sql
        .prepare('DELETE FROM resource_categories WHERE id=?')
        .run(req.params.id)
      return { deleted: true }
    },
  )
  app.get('/v1/resources', async (req) =>
    resources.list(req.userId, querySchema.parse(req.query)),
  )
  app.post('/v1/resources', { bodyLimit: 15 * 1024 * 1024 }, async (req) => {
    limits.take(`resource-write:${req.userId}`, 30)
    const input = createResourceSchema.parse(req.body)
    const resource = resources.create(req.userId, input, input.files)
    return { ...resource, files: resources.files(resource.id) }
  })
  app.get<{ Params: { id: string } }>(
    '/v1/resources/:id',
    async (req, reply) => {
      reply.header('Cache-Control', 'private, no-store')
      const resource = resources.get(req.params.id, req.userId)
      return {
        ...resource,
        categoryId:
          resource.ownerId === req.userId ? resource.categoryId : null,
        files: resources.files(resource.id),
      }
    },
  )
  app.post<{ Params: { id: string } }>(
    '/v1/resources/:id/view',
    async (req) => {
      limits.take(`resource-view:${req.userId}`, 60)
      const resource = resources.get(req.params.id, req.userId)
      if (resource.visibility === 'public' && resource.ownerId !== req.userId)
        store.sql
          .prepare(
            'INSERT INTO resource_views VALUES(?,?,?) ON CONFLICT(resourceId,viewerId) DO UPDATE SET viewedAt=excluded.viewedAt',
          )
          .run(resource.id, req.userId, Date.now())
      store.sql
        .prepare('DELETE FROM resource_views WHERE viewedAt<?')
        .run(Date.now() - 7 * 86400000)
      return { ok: true }
    },
  )
  app.patch<{ Params: { id: string } }>(
    '/v1/resources/:id',
    { bodyLimit: RESOURCE_METADATA_BODY_LIMIT },
    async (req) => {
      limits.take(`resource-write:${req.userId}`, 30)
      const resource = resources.update(
        req.params.id,
        req.userId,
        metadataSchema.parse(req.body),
      )
      return { ...resource, files: resources.files(resource.id) }
    },
  )
  app.delete<{ Params: { id: string } }>('/v1/resources/:id', async (req) => {
    limits.take(`resource-write:${req.userId}`, 30)
    resources.get(req.params.id, req.userId, true)
    store.sql.prepare('DELETE FROM resources WHERE id=?').run(req.params.id)
    return { deleted: true }
  })
  app.get<{ Params: { id: string; fileId: string } }>(
    '/v1/resources/:id/files/:fileId',
    async (req, reply) => {
      resources.get(req.params.id, req.userId)
      const file = store.sql
        .prepare('SELECT * FROM resource_files WHERE id=? AND resourceId=?')
        .get(req.params.fileId, req.params.id) as
        { name: string; mime: string; content: Buffer } | undefined
      if (!file) throw new ServiceError('notFound', 'File not found', 404)
      const preview = z
        .object({ preview: z.enum(['1']).optional() })
        .parse(req.query).preview
      reply.header('Cache-Control', 'private, no-store')
      reply.header('X-Content-Type-Options', 'nosniff')
      reply.header('Content-Security-Policy', "sandbox; default-src 'none'")
      reply.header(
        'Content-Disposition',
        `${preview ? 'inline' : 'attachment'}; filename="resource"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, '%27')}`,
      )
      return reply
        .type(preview ? file.mime : 'application/octet-stream')
        .send(file.content)
    },
  )
}
