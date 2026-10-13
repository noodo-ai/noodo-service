import { ServiceError, publicError, type ToolOutput } from '../contracts.js'
import type { InfoClient } from './client.js'
import {
  createOutput,
  checkAccountRole,
  type ToolContext,
} from './tool-context.js'
import type { QueryResult } from './client.js'
import { marketSchema, fillsSchema, type Fill } from './schemas.js'

export async function getFills(
  client: InfoClient,

  args: { startTime?: number; endTime?: number },
  ctx: ToolContext,
): Promise<ToolOutput> {
  const out = createOutput(ctx)
  const endTime = args.endTime ?? Date.now(),
    startTime = args.startTime ?? endTime - 7 * 86400000,
    historical = args.startTime !== undefined
  if (
    startTime >= endTime ||
    endTime > Date.now() ||
    endTime - startTime > 30 * 86400000
  )
    throw new ServiceError(
      'invalidTimeRange',
      'Fill range must be in the past and at most 30 days',
    )
  out.coverage = {
    ...out.coverage,
    complete: false,
    requestedRange: { startTime, endTime },
    returnedRange: null,
    scannedThrough: null,
    sortOrder: historical ? 'timeAsc,tidAsc' : 'timeDesc,tidAsc',
    excludedCount: 0,
    truncationReasons: [],
    reasonCodes: [
      historical ? 'retentionUnverified' : 'recentWindowUnverified',
    ],
  }
  if (!(await checkAccountRole(client, ctx, out))) return out
  const metadata = await client.query('metaAndAssetCtxs', {}, marketSchema, {
    ...ctx,
    ttlMs: 300000,
  })
  out.sources.push(metadata.source)
  const known = new Set(
    metadata.data[0].universe.filter((a) => !a.isDelisted).map((a) => a.name),
  )
  const attempts = { remaining: 3 },
    seen = new Set<string>(),
    found: Fill[] = []
  let cursor = startTime
  while (attempts.remaining > 0) {
    let response: QueryResult<Fill[]>
    try {
      response = await client.query(
        historical ? 'userFillsByTime' : 'userFills',
        {
          user: ctx.address,
          aggregateByTime: false,
          ...(historical ? { startTime: cursor, endTime } : {}),
        },
        fillsSchema,
        { ...ctx, attempts },
      )
    } catch (e) {
      out.coverage.reasonCodes.push(publicError(e).code)
      break
    }
    out.sources.push(response.source)
    const raw = response.data
    let max = cursor
    for (const fill of raw) {
      max = Math.max(max, fill.time)
      const key = `${ctx.address}:${fill.coin}:${fill.tid}`
      if (seen.has(key)) continue
      seen.add(key)
      if (!known.has(fill.coin)) {
        out.coverage.excludedCount!++
        continue
      }
      if (fill.time >= startTime && fill.time <= endTime) found.push(fill)
    }
    out.coverage.scannedThrough = raw.length ? max : out.coverage.scannedThrough
    if (!historical) {
      if (raw.length >= 2000)
        out.coverage.truncationReasons!.push('upstreamRecentWindow')
      break
    }
    if (max >= endTime) break
    if (raw.length === 0) break
    if (max <= cursor) {
      out.coverage.truncationReasons!.push('boundaryStalled')
      break
    }
    cursor = max // inclusive cursor: never skip tied timestamp records
    if (found.length > 1000) {
      out.coverage.truncationReasons!.push('outputLimit')
      break
    }
    if (attempts.remaining <= 0)
      out.coverage.truncationReasons!.push('queryBudgetExceeded')
  }
  found.sort(
    (a, b) =>
      (historical ? a.time - b.time : b.time - a.time) ||
      (BigInt(a.tid) < BigInt(b.tid)
        ? -1
        : BigInt(a.tid) > BigInt(b.tid)
          ? 1
          : 0),
  )
  if (
    found.length > 1000 &&
    !out.coverage.truncationReasons!.includes('outputLimit')
  )
    out.coverage.truncationReasons!.push('outputLimit')
  const returned = found.slice(0, 1000)
  if (returned.length)
    out.coverage.returnedRange = {
      startTime: Math.min(...returned.map((f) => f.time)),
      endTime: Math.max(...returned.map((f) => f.time)),
    }
  if (out.coverage.excludedCount)
    out.coverage.reasonCodes.push('excludedUnknownAsset')
  out.data = {
    role: out.data.role,
    fills: returned,
    sourceIds: out.sources
      .filter((s) => s.queryType.startsWith('userFills'))
      .map((s) => s.sourceId),
    sampleKind: historical
      ? 'partialHistoricalInterval'
      : 'recentAvailableSample',
  }
  out.warnings.push(
    historical
      ? 'Partial historical interval: retention boundary has not been verified; early rows must not be called the latest fills.'
      : 'Recent available sample only; few or no rows do not establish a complete seven-day trading history.',
  )
  out.warnings.push(
    'Record time is not a snapshot timestamp. Fees retain feeToken; do not sum different currencies. Limited fills cannot establish total performance or funding and cash flows.',
  )
  return out
}
