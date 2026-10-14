import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import * as schema from './schema.js'
import {
  CONTRACT_VERSION,
  SCOPE,
  ServiceError,
  emptyResult,
  type RunResult,
  type ApiError,
} from '../contracts.js'
import type { Config } from '../config.js'
import { resolveMessageAddress } from '../conversation-address.js'
export type Conversation = typeof schema.conversations.$inferSelect
export type Run = typeof schema.runs.$inferSelect
export type ChatMessage = typeof schema.messages.$inferSelect
export interface Usage {
  input: number
  output: number
  unconfirmed: number
}
export const quotaDate = (time = Date.now()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(time)
export class Store {
  sql: Database.Database
  db: ReturnType<typeof drizzle<typeof schema>>
  constructor(path: string) {
    if (path !== ':memory:')
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.sql = new Database(path)
    this.sql.pragma('foreign_keys = ON')
    this.sql.pragma('journal_mode = WAL')
    this.sql.pragma('busy_timeout = 3000')
    this.sql.exec(
      readFileSync(
        new URL('../../migrations/0001_initial.sql', import.meta.url),
        'utf8',
      ),
    )
    if (
      !this.sql.prepare('SELECT 1 FROM schema_migrations WHERE version=2').get()
    )
      this.sql.transaction(() =>
        this.sql.exec(
          readFileSync(
            new URL('../../migrations/0002_tool_use_id.sql', import.meta.url),
            'utf8',
          ),
        ),
      )()
    if (
      !this.sql.prepare('SELECT 1 FROM schema_migrations WHERE version=3').get()
    )
      this.sql.transaction(() =>
        this.sql.exec(
          readFileSync(
            new URL(
              '../../migrations/0003_conversation_deletion.sql',
              import.meta.url,
            ),
            'utf8',
          ),
        ),
      )()
    this.db = drizzle(this.sql, { schema })
  }
  user(username: string) {
    return this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, username))
      .get()
  }
  owner(id: string, ownerId: string): Conversation {
    const c = this.sql
      .prepare(
        'SELECT * FROM conversations WHERE id=? AND ownerId=? AND deletedAt IS NULL',
      )
      .get(id, ownerId) as Conversation | undefined
    if (!c) throw new ServiceError('notFound', 'Conversation not found', 404)
    return c
  }
  run(id: string, ownerId: string): Run {
    const run = this.sql
      .prepare(
        'SELECT runs.* FROM runs JOIN conversations ON conversations.id=runs.conversationId WHERE runs.id=? AND runs.ownerId=? AND conversations.deletedAt IS NULL',
      )
      .get(id, ownerId) as Run | undefined
    if (!run) throw new ServiceError('notFound', 'Run not found', 404)
    return run
  }
  create(ownerId: string, observedAddress: string | null): Conversation {
    const id = randomUUID(),
      now = Date.now()
    this.sql
      .prepare(
        'INSERT INTO conversations(id,ownerId,observedAddress,addressVersion,title,createdAt,updatedAt) VALUES(?,?,?,1,?,?,?)',
      )
      .run(id, ownerId, observedAddress, 'New chat', now, now)
    return this.owner(id, ownerId)
  }
  deleteConversation(id: string, ownerId: string): void {
    this.sql
      .transaction(() => {
        this.owner(id, ownerId)
        if (
          this.sql
            .prepare(
              "SELECT 1 FROM runs WHERE conversationId=? AND status='running'",
            )
            .get(id)
        )
          throw new ServiceError(
            'conversationBusy',
            'Wait for the active run before deleting this chat',
            409,
            true,
          )
        this.sql.prepare('DELETE FROM messages WHERE conversationId=?').run(id)
        this.sql
          .prepare(
            'DELETE FROM tool_calls WHERE runId IN (SELECT id FROM runs WHERE conversationId=?)',
          )
          .run(id)
        // Keep settled accounting until normal retention expires so deletion cannot reset quotas.
        this.sql
          .prepare(
            'UPDATE runs SET result=NULL,error=NULL,observedAddress=NULL WHERE conversationId=?',
          )
          .run(id)
        this.sql
          .prepare(
            "UPDATE conversations SET deletedAt=?,title='Deleted chat',observedAddress=NULL WHERE id=?",
          )
          .run(Date.now(), id)
      })
      .immediate()
  }
  updateAddress(
    id: string,
    ownerId: string,
    address: string | null,
    version: number,
  ): Conversation {
    return this.sql
      .transaction(() => {
        const c = this.owner(id, ownerId)
        if (
          this.sql
            .prepare(
              "SELECT id FROM runs WHERE conversationId=? AND status='running'",
            )
            .get(id)
        )
          throw new ServiceError(
            'conversationBusy',
            'Wait for the active run before changing address',
            409,
          )
        if (c.addressVersion !== version)
          throw new ServiceError(
            'addressVersionConflict',
            'Account address changed; reload the conversation',
            409,
          )
        this.sql
          .prepare(
            'UPDATE conversations SET observedAddress=?,addressVersion=addressVersion+1,updatedAt=? WHERE id=?',
          )
          .run(address, Date.now(), id)
        return this.owner(id, ownerId)
      })
      .immediate()
  }
  accept(
    id: string,
    ownerId: string,
    payload: {
      clientRequestId: string
      text: string
      expectedAddressVersion: number
    },
    config: Config,
  ): { run: Run; duplicate: boolean } {
    return this.sql
      .transaction(() => {
        const c = this.owner(id, ownerId)
        const hash = createHash('sha256')
          .update(
            JSON.stringify({
              version: CONTRACT_VERSION,
              text: payload.text,
              expectedAddressVersion: payload.expectedAddressVersion,
            }),
          )
          .digest('hex')
        const existing = this.sql
          .prepare(
            'SELECT * FROM runs WHERE conversationId=? AND clientRequestId=?',
          )
          .get(id, payload.clientRequestId) as Run | undefined
        if (existing) {
          if (existing.requestHash !== hash)
            throw new ServiceError(
              'idempotencyConflict',
              'Request ID already used with a different payload',
              409,
            )
          return { run: existing, duplicate: true }
        }
        if (c.addressVersion !== payload.expectedAddressVersion)
          throw new ServiceError(
            'addressVersionConflict',
            'Account address changed; reload the conversation',
            409,
          )
        if (
          this.sql
            .prepare(
              "SELECT id FROM runs WHERE conversationId=? AND status='running'",
            )
            .get(id)
        )
          throw new ServiceError(
            'conversationBusy',
            'Conversation already has an active run',
            409,
            true,
          )
        const today = quotaDate()
        const count = this.sql
          .prepare(
            'SELECT COUNT(*) AS n FROM runs WHERE ownerId=? AND quotaDate=?',
          )
          .get(ownerId, today) as { n: number }
        if (count.n >= config.USER_DAILY_REQUEST_LIMIT)
          throw new ServiceError(
            'dailyRequestLimit',
            'Daily request allowance reached',
            429,
          )
        const budget = this.sql
          .prepare(
            'SELECT COALESCE(SUM(COALESCE(settledTokens,reservedTokens)),0) AS n FROM runs WHERE quotaDate=?',
          )
          .get(today) as { n: number }
        if (budget.n + 32000 > config.GLOBAL_DAILY_TOKEN_LIMIT)
          throw new ServiceError(
            'dailyTokenLimit',
            'Daily service token allowance reached',
            429,
          )
        const active = this.sql
          .prepare("SELECT COUNT(*) AS n FROM runs WHERE status='running'")
          .get() as { n: number }
        if (active.n >= 10)
          throw new ServiceError(
            'concurrencyLimit',
            'Service is busy; try again shortly',
            429,
            true,
          )
        const observedAddress = resolveMessageAddress(
          payload.text,
          c.observedAddress,
        )
        if (observedAddress !== c.observedAddress) {
          c.observedAddress = observedAddress
          c.addressVersion++
          this.sql
            .prepare(
              'UPDATE conversations SET observedAddress=?,addressVersion=? WHERE id=?',
            )
            .run(c.observedAddress, c.addressVersion, id)
        }
        const runId = randomUUID(),
          now = Math.max(
            Date.now(),
            (
              this.sql
                .prepare(
                  'SELECT COALESCE(MAX(createdAt),0) AS n FROM messages WHERE conversationId=?',
                )
                .get(id) as { n: number }
            ).n + 1,
          )
        this.sql
          .prepare(
            'INSERT INTO runs(id,conversationId,ownerId,clientRequestId,requestHash,status,observedAddress,addressVersion,marketScope,result,error,provider,model,adapterVersion,promptVersion,tokenUsage,quotaDate,reservedTokens,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            runId,
            id,
            ownerId,
            payload.clientRequestId,
            hash,
            'running',
            c.observedAddress,
            c.addressVersion,
            SCOPE,
            JSON.stringify(emptyResult()),
            null,
            'anthropic',
            config.CLAUDE_MODEL,
            'claude-provider-v1',
            'hyperliquid-v4',
            '{}',
            today,
            32000,
            now,
            now,
          )
        this.sql
          .prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?)')
          .run(
            randomUUID(),
            id,
            runId,
            'user',
            payload.text,
            'final',
            c.observedAddress,
            c.addressVersion,
            now,
          )
        this.sql
          .prepare(
            'UPDATE conversations SET title=CASE WHEN title=? THEN ? ELSE title END,updatedAt=? WHERE id=?',
          )
          .run('New chat', payload.text.slice(0, 80), now, id)
        return { run: this.run(runId, ownerId), duplicate: false }
      })
      .immediate()
  }
  checkpoint(runId: string, result: RunResult, usage: Usage, model?: string) {
    this.sql
      .prepare(
        "UPDATE runs SET result=?,tokenUsage=?,model=COALESCE(?,model),updatedAt=? WHERE id=? AND status='running'",
      )
      .run(
        JSON.stringify(result),
        JSON.stringify(usage),
        model ?? null,
        Date.now(),
        runId,
      )
  }
  finish(
    run: Run,
    status: 'completed' | 'failed' | 'interrupted',
    result: RunResult,
    usage: Usage,
    error: ApiError | null,
  ): boolean {
    return this.sql
      .transaction(() => {
        for (const item of result.activity ?? [])
          if (
            item.type === 'tool' &&
            ['preparing', 'running'].includes(item.status)
          )
            item.status = 'failed'
        const now = Math.max(
            Date.now(),
            (
              this.sql
                .prepare(
                  'SELECT COALESCE(MAX(createdAt),0) AS n FROM messages WHERE conversationId=?',
                )
                .get(run.conversationId) as { n: number }
            ).n + 1,
          ),
          settled = Math.min(
            32000,
            usage.input + usage.output + usage.unconfirmed,
          )
        const update = this.sql
          .prepare(
            "UPDATE runs SET status=?,result=?,error=?,tokenUsage=?,settledTokens=?,settledAt=?,updatedAt=? WHERE id=? AND status='running'",
          )
          .run(
            status,
            JSON.stringify(result),
            error ? JSON.stringify(error) : null,
            JSON.stringify(usage),
            settled,
            now,
            now,
            run.id,
          )
        if (!update.changes) return false
        this.sql
          .prepare(
            "UPDATE tool_calls SET status='failed',error=?,updatedAt=? WHERE runId=? AND status IN ('preparing','running')",
          )
          .run(
            JSON.stringify(
              error ?? {
                code: 'incompleteToolInput',
                message: 'Tool call was not completed',
                retryable: true,
              },
            ),
            now,
            run.id,
          )
        this.sql
          .prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?)')
          .run(
            randomUUID(),
            run.conversationId,
            run.id,
            'assistant',
            result.text,
            result.textStatus,
            run.observedAddress,
            run.addressVersion,
            now,
          )
        this.sql
          .prepare('UPDATE conversations SET updatedAt=? WHERE id=?')
          .run(now, run.conversationId)
        return true
      })
      .immediate()
  }
  recover() {
    const running = this.sql
      .prepare("SELECT * FROM runs WHERE status='running'")
      .all() as Run[]
    for (const run of running) {
      this.sql
        .prepare(
          "UPDATE tool_calls SET status='failed',error=?,updatedAt=? WHERE runId=? AND status IN ('preparing','running')",
        )
        .run(
          JSON.stringify({
            code: 'serviceRestarted',
            message: 'Interrupted by restart',
            retryable: true,
          }),
          Date.now(),
          run.id,
        )
      const result = JSON.parse(run.result ?? 'null') as RunResult | null
      const saved = result ?? emptyResult()
      saved.textStatus = saved.text ? 'partial' : 'unavailable'
      this.finish(
        run,
        'interrupted',
        saved,
        { input: 0, output: 0, unconfirmed: 32000 },
        {
          code: 'serviceRestarted',
          message: 'Service restarted; response is incomplete',
          retryable: true,
        },
      )
    }
  }
  history(
    id: string,
    limit = 50,
    cursor?: string,
  ): { messages: ChatMessage[]; nextCursor: string | null } {
    let page: ChatMessage[]
    if (cursor) {
      let c: { time: number; id: string }
      try {
        c = JSON.parse(Buffer.from(cursor, 'base64url').toString())
        if (!Number.isSafeInteger(c.time) || typeof c.id !== 'string')
          throw new Error()
      } catch {
        throw new ServiceError('invalidCursor', 'Invalid history cursor')
      }
      page = this.sql
        .prepare(
          'SELECT * FROM messages WHERE conversationId=? AND (createdAt<? OR (createdAt=? AND id<?)) ORDER BY createdAt DESC,id DESC LIMIT ?',
        )
        .all(id, c.time, c.time, c.id, limit + 1) as ChatMessage[]
    } else
      page = this.sql
        .prepare(
          'SELECT * FROM messages WHERE conversationId=? ORDER BY createdAt DESC,id DESC LIMIT ?',
        )
        .all(id, limit + 1) as ChatMessage[]
    const more = page.length > limit
    page = page.slice(0, limit)
    const last = page.at(-1)
    return {
      messages: page.reverse(),
      nextCursor:
        more && last
          ? Buffer.from(
              JSON.stringify({ time: last.createdAt, id: last.id }),
            ).toString('base64url')
          : null,
    }
  }
  prune() {
    return this.sql
      .transaction(() => {
        this.sql
          .prepare('DELETE FROM sessions WHERE expiresAt<?')
          .run(Date.now())
        const cutoff = Date.now() - 30 * 86400000
        const removed = this.sql
          .prepare(
            "DELETE FROM runs WHERE createdAt<? AND status!='running' AND quotaDate<?",
          )
          .run(cutoff, quotaDate()).changes
        this.sql
          .prepare(
            'DELETE FROM conversations WHERE updatedAt<? AND NOT EXISTS(SELECT 1 FROM runs WHERE runs.conversationId=conversations.id)',
          )
          .run(cutoff)
        return removed
      })
      .immediate()
  }
  close() {
    this.sql.close()
  }
}
