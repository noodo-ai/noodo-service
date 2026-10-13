import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { ServiceError, type Source } from '../contracts.js'
export const INFO_URL = 'https://api.hyperliquid.xyz/info'
export type QueryType =
  | 'metaAndAssetCtxs'
  | 'candleSnapshot'
  | 'userRole'
  | 'userAbstraction'
  | 'clearinghouseState'
  | 'frontendOpenOrders'
  | 'userFills'
  | 'userFillsByTime'
const allowed = new Set<QueryType>([
  'metaAndAssetCtxs',
  'candleSnapshot',
  'userRole',
  'userAbstraction',
  'clearinghouseState',
  'frontendOpenOrders',
  'userFills',
  'userFillsByTime',
])
interface Snapshot {
  raw: unknown
  fetchedAt: number
  timestamp: number | null
}
export interface QueryResult<T> {
  data: T
  source: Source
}
interface QueryOptions {
  signal: AbortSignal
  deadline: number
  toolCallId: string
  force?: boolean
  attempts?: { remaining: number }
  ttlMs?: number
}
export class WeightedLimiter {
  private spent: { time: number; weight: number }[] = []
  cooldown = 0
  constructor(
    private max = 900,
    private resource = 'Hyperliquid',
  ) {}
  async take(weight: number, signal: AbortSignal, deadline: number) {
    while (true) {
      signal.throwIfAborted()
      const now = Date.now()
      this.spent = this.spent.filter((x) => now - x.time < 60000)
      const total = this.spent.reduce((s, x) => s + x.weight, 0)
      if (now >= this.cooldown && total + weight <= this.max) {
        this.spent.push({ time: now, weight })
        return
      }
      const until = Math.max(
        this.cooldown,
        total + weight > this.max ? (this.spent[0]?.time ?? now) + 60000 : now,
      )
      const wait = Math.max(1, until - now)
      if (now + wait + 1000 >= deadline)
        throw new ServiceError(
          this.resource === 'Claude'
            ? 'modelRateLimited'
            : 'upstreamRateLimited',
          `${this.resource} rate budget exhausted`,
          503,
          true,
        )
      await delay(wait, undefined, { signal })
    }
  }
  charge(weight: number) {
    if (weight > 0) this.spent.push({ time: Date.now(), weight })
  }
}
export class InfoClient {
  private cache = new Map<string, Snapshot>()
  private pending = new Map<
    string,
    {
      promise: Promise<Snapshot>
      controller: AbortController
      subscribers: number
    }
  >()
  private limiter: WeightedLimiter
  constructor(
    maxWeight = 900,
    private fetcher: typeof fetch = fetch,
    private capacity = 256,
  ) {
    this.limiter = new WeightedLimiter(maxWeight)
  }
  async query<T>(
    type: QueryType,
    params: Record<string, unknown>,
    schema: z.ZodType<T>,
    options: QueryOptions,
  ): Promise<QueryResult<T>> {
    if (!allowed.has(type))
      throw new ServiceError('queryForbidden', 'Unsupported upstream query')
    const body = {
      ...params,
      type,
      ...([
        'metaAndAssetCtxs',
        'clearinghouseState',
        'frontendOpenOrders',
      ].includes(type)
        ? { dex: '' }
        : {}),
    }
    const key = JSON.stringify({ network: 'mainnet', dex: '', body })
    const ttl =
      options.ttlMs ??
      (type === 'userRole' ? 60000 : type === 'metaAndAssetCtxs' ? 10000 : 5000)
    const cached = this.cache.get(key)
    const cacheHit =
      !options.force && !!cached && Date.now() - cached.fetchedAt < ttl
    let snapshot: Snapshot
    if (cacheHit) snapshot = cached!
    else {
      options.signal.throwIfAborted()
      let shared = this.pending.get(key)
      if (!shared) {
        const controller = new AbortController()
        const sharedSignal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(
            Math.max(1, Math.min(17000, options.deadline - Date.now())),
          ),
        ])
        const promise = this.fetchSnapshot(
          type,
          body,
          schema,
          sharedSignal,
          options.deadline,
          options.attempts,
        )
          .then((snapshot) => {
            this.cache.delete(key)
            this.cache.set(key, snapshot)
            while (this.cache.size > this.capacity)
              this.cache.delete(this.cache.keys().next().value!)
            return snapshot
          })
          .finally(() => this.pending.delete(key))
        shared = { promise, controller, subscribers: 0 }
        this.pending.set(key, shared)
      }
      shared.subscribers++
      try {
        snapshot = await waitFor(shared.promise, options.signal)
      } finally {
        shared.subscribers--
        if (shared.subscribers === 0) shared.controller.abort()
      }
    }
    const parsed = schema.safeParse(snapshot.raw)
    if (!parsed.success)
      throw new ServiceError(
        'upstreamSchemaMismatch',
        'Hyperliquid response schema did not match',
        502,
      )
    return {
      data: parsed.data,
      source: {
        sourceId: randomUUID(),
        toolCallId: options.toolCallId,
        provider: 'hyperliquid',
        queryType: type,
        fetchedAt: snapshot.fetchedAt,
        cacheHit,
        timestamp: snapshot.timestamp,
      },
    }
  }
  private async fetchSnapshot<T>(
    type: QueryType,
    body: Record<string, unknown>,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    deadline: number,
    attempts?: { remaining: number },
  ): Promise<Snapshot> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempts && attempts.remaining <= 0)
        throw new ServiceError(
          'queryBudgetExceeded',
          'Fill query budget exhausted',
          503,
          true,
        )
      await this.limiter.take(
        type === 'userRole'
          ? 60
          : type === 'clearinghouseState'
            ? 2
            : type === 'userFills' || type === 'userFillsByTime'
              ? 120
              : type === 'candleSnapshot'
                ? 24
                : 20,
        signal,
        deadline,
      )
      if (attempts) attempts.remaining--
      try {
        const response = await this.fetcher(INFO_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(
              Math.max(1, Math.min(8000, deadline - Date.now())),
            ),
          ]),
          redirect: 'error',
        })
        if (!response.ok) {
          if (response.status === 429) {
            const h = response.headers.get('retry-after'),
              seconds = h ? Number(h) : NaN
            const wait = Number.isFinite(seconds)
              ? seconds * 1000
              : h
                ? Math.max(0, Date.parse(h) - Date.now())
                : 1000
            this.limiter.cooldown = Math.max(
              this.limiter.cooldown,
              Date.now() + Math.min(Number.isFinite(wait) ? wait : 1000, 60000),
            )
          }
          throw new ServiceError(
            response.status === 429
              ? 'upstreamRateLimited'
              : 'upstreamUnavailable',
            'Hyperliquid query failed',
            502,
            response.status === 429 || response.status >= 500,
          )
        }
        // Parse IDs losslessly: the upstream can return integers beyond JS's safe range.
        const { parse } = await import('lossless-json')
        const raw = parse(await response.text(), undefined, {
          parseNumber: (n: string) =>
            /^-?\d+$/.test(n) && !Number.isSafeInteger(Number(n))
              ? n
              : Number(n),
        })
        if (!schema.safeParse(raw).success)
          throw new ServiceError(
            'upstreamSchemaMismatch',
            'Hyperliquid response schema did not match',
            502,
          )
        const fetchedAt = Date.now()
        if (
          Array.isArray(raw) &&
          ['userFills', 'userFillsByTime', 'candleSnapshot'].includes(type)
        ) {
          const reservedItems = type === 'candleSnapshot' ? 240 : 2000
          if (raw.length > reservedItems)
            this.limiter.charge(
              Math.ceil(
                (raw.length - reservedItems) /
                  (type === 'candleSnapshot' ? 60 : 20),
              ),
            )
        }
        const timestamp =
          type === 'clearinghouseState' &&
          raw &&
          typeof raw === 'object' &&
          'time' in raw &&
          typeof raw.time === 'number'
            ? raw.time
            : null
        return { raw, fetchedAt, timestamp }
      } catch (e) {
        const err =
          e instanceof ServiceError
            ? e
            : new ServiceError(
                'upstreamUnavailable',
                'Hyperliquid network request failed',
                502,
                true,
              )
        if (signal.aborted) throw err
        if (!err.retryable || attempt === 1 || Date.now() + 1000 >= deadline)
          throw err
        await delay(250 + Math.random() * 250, undefined, { signal })
      }
    }
    throw new ServiceError(
      'upstreamUnavailable',
      'Hyperliquid unavailable',
      502,
      true,
    )
  }
}
export function waitFor<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    signal.addEventListener('abort', aborted, { once: true })
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', aborted))
  })
}
