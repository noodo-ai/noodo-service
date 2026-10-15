import { randomUUID } from 'node:crypto'
import type { Store } from './store.js'
import { ServiceError } from '../contracts.js'
import {
  MAX_RESOURCE_BYTES,
  USER_RESOURCE_BYTES,
  type ResourceInput,
  type ResourceRow,
  type ResourceFile,
  decodeFile,
} from '../resources/contracts.js'

const select =
  'SELECT r.*, u.username AS author FROM resources r JOIN users u ON u.id=r.ownerId'
export class ResourceStore {
  constructor(private store: Store) {}
  get(id: string, userId: string, ownerOnly = false): ResourceRow {
    const row = this.store.sql
      .prepare(
        `${select} WHERE r.id=? AND (r.ownerId=? ${ownerOnly ? '' : "OR r.visibility='public'"})`,
      )
      .get(id, userId) as ResourceRow | undefined
    if (!row) throw new ServiceError('notFound', 'Resource not found', 404)
    return row
  }
  files(id: string): ResourceFile[] {
    return this.store.sql
      .prepare(
        'SELECT id,name,format,mime,bytes FROM resource_files WHERE resourceId=? ORDER BY rowid',
      )
      .all(id) as ResourceFile[]
  }
  private checkCategory(categoryId: string | null, userId: string): void {
    if (
      categoryId &&
      !this.store.sql
        .prepare('SELECT id FROM resource_categories WHERE id=? AND ownerId=?')
        .get(categoryId, userId)
    )
      throw new ServiceError('notFound', 'Category not found', 404)
  }
  private checkQuota(userId: string, bytes: number, exclude = ''): void {
    if (bytes > MAX_RESOURCE_BYTES)
      throw new ServiceError(
        'fileTooLarge',
        'A resource can contain at most 10 MB of content',
      )
    const used = this.store.sql
      .prepare(
        'SELECT coalesce(sum(bytes),0) AS bytes, count(*) AS count FROM resources WHERE ownerId=? AND id!=?',
      )
      .get(userId, exclude) as { bytes: number; count: number }
    if (used.bytes + bytes > USER_RESOURCE_BYTES || used.count >= 1000)
      throw new ServiceError(
        'storageLimit',
        'Your resource storage limit has been reached',
        409,
      )
  }
  create(
    userId: string,
    input: ResourceInput,
    files: { name: string; base64: string }[],
  ): ResourceRow {
    const decoded = files.map(decodeFile)
    if (!input.body.trim() && !decoded.length)
      throw new ServiceError('emptyResource', 'Add report text or a file')
    const bytes =
      Buffer.byteLength(input.body) +
      decoded.reduce((sum, f) => sum + f.bytes, 0)
    return this.store.sql
      .transaction(() => {
        this.checkCategory(input.categoryId, userId)
        this.checkQuota(userId, bytes)
        const id = randomUUID()
        const now = Date.now()
        this.store.sql
          .prepare('INSERT INTO resources VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(
            id,
            userId,
            input.title,
            input.summary,
            input.body,
            input.visibility,
            input.categoryId,
            input.topic,
            bytes,
            now,
            now,
          )
        for (const f of decoded)
          this.store.sql
            .prepare('INSERT INTO resource_files VALUES(?,?,?,?,?,?,?)')
            .run(randomUUID(), id, f.name, f.format, f.mime, f.bytes, f.content)
        return this.get(id, userId)
      })
      .immediate()
  }
  update(id: string, userId: string, input: ResourceInput): ResourceRow {
    return this.store.sql
      .transaction(() => {
        const old = this.get(id, userId, true)
        this.checkCategory(input.categoryId, userId)
        if (!input.body.trim() && !this.files(id).length)
          throw new ServiceError('emptyResource', 'Add report text or a file')
        const bytes =
          old.bytes -
          Buffer.byteLength(old.body) +
          Buffer.byteLength(input.body)
        this.checkQuota(userId, bytes, id)
        this.store.sql
          .prepare(
            'UPDATE resources SET title=?,summary=?,body=?,visibility=?,categoryId=?,topic=?,bytes=?,updatedAt=? WHERE id=?',
          )
          .run(
            input.title,
            input.summary,
            input.body,
            input.visibility,
            input.categoryId,
            input.topic,
            bytes,
            Date.now(),
            id,
          )
        return this.get(id, userId)
      })
      .immediate()
  }
  list(
    userId: string,
    query: {
      scope: string
      search: string
      visibility?: string
      categoryId?: string
      topic?: string
      format?: string
      sort: string
      offset: number
      limit: number
    },
  ) {
    const conditions = [
      query.scope === 'personal' ? 'r.ownerId=?' : "r.visibility='public'",
    ]
    const params: (string | number)[] =
      query.scope === 'personal' ? [userId] : []
    if (query.search) {
      conditions.push(
        "(r.title LIKE ? ESCAPE '\\' OR r.summary LIKE ? ESCAPE '\\')",
      )
      const search = `%${query.search.replace(/[\\%_]/g, '\\$&')}%`
      params.push(search, search)
    }
    for (const key of ['visibility', 'topic'] as const)
      if (query[key]) {
        conditions.push(`r.${key}=?`)
        params.push(query[key])
      }
    if (query.scope === 'personal' && query.categoryId) {
      if (query.categoryId === 'uncategorized')
        conditions.push('r.categoryId IS NULL')
      else {
        conditions.push('r.categoryId=?')
        params.push(query.categoryId)
      }
    }
    if (query.format === 'jpg' || query.format === 'jpeg') {
      conditions.push(
        "EXISTS(SELECT 1 FROM resource_files f WHERE f.resourceId=r.id AND f.format IN ('jpg','jpeg'))",
      )
    } else if (query.format) {
      conditions.push(
        query.format === 'md'
          ? "(length(trim(r.body))>0 OR EXISTS(SELECT 1 FROM resource_files f WHERE f.resourceId=r.id AND f.format='md'))"
          : 'EXISTS(SELECT 1 FROM resource_files f WHERE f.resourceId=r.id AND f.format=?)',
      )
      if (query.format !== 'md') params.push(query.format)
    }
    const rows = this.store.sql
      .prepare(
        `SELECT r.id,r.ownerId,r.title,r.summary,r.visibility,${query.scope === 'personal' ? 'r.categoryId' : 'NULL AS categoryId'},r.topic,r.bytes,r.createdAt,r.updatedAt,u.username AS author,length(trim(r.body))>0 AS hasBody,(SELECT count(*) FROM resource_views v WHERE v.resourceId=r.id AND v.viewedAt>?) AS views FROM resources r JOIN users u ON u.id=r.ownerId WHERE ${conditions.join(' AND ')} ORDER BY ${query.sort === 'popular' ? 'views DESC,' : ''}r.updatedAt DESC,r.id DESC LIMIT ? OFFSET ?`,
      )
      .all(
        Date.now() - 7 * 86400000,
        ...params,
        query.limit + 1,
        query.offset,
      ) as (Omit<ResourceRow, 'body'> & { hasBody: number; views: number })[]
    return {
      resources: rows
        .slice(0, query.limit)
        .map((r) => ({ ...r, files: this.files(r.id) })),
      nextOffset: rows.length > query.limit ? query.offset + query.limit : null,
    }
  }
}
