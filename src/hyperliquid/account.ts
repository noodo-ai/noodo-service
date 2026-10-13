import { ServiceError, publicError, type ToolOutput } from '../contracts.js'
import type { InfoClient } from './client.js'
import {
  createOutput,
  checkAccountRole,
  type ToolContext,
} from './tool-context.js'
import type { QueryResult } from './client.js'
import {
  modeSchema,
  accountSchema,
  ordersSchema,
  marketSchema,
} from './schemas.js'
import { calculateRisk } from './risk.js'

export async function getAccount(
  client: InfoClient,
  supportedModes: string[],
  ctx: ToolContext,
): Promise<ToolOutput> {
  const out = createOutput(ctx)
  if (!(await checkAccountRole(client, ctx, out))) return out
  const queries = await Promise.allSettled([
    client.query('userAbstraction', { user: ctx.address }, modeSchema, ctx),
    client.query(
      'clearinghouseState',
      { user: ctx.address },
      accountSchema,
      ctx,
    ),
    client.query(
      'frontendOpenOrders',
      { user: ctx.address },
      ordersSchema,
      ctx,
    ),
    client.query('metaAndAssetCtxs', {}, marketSchema, ctx),
  ])
  const [mode, , orders] = queries
  let [, account, , market] = queries
  for (const q of queries)
    if (q.status === 'fulfilled') out.sources.push(q.value.source)
  if (account.status === 'rejected') throw publicError(account.reason)
  const supported =
    mode.status === 'fulfilled' && supportedModes.includes(mode.value.data)
  if (!supported) {
    out.coverage.complete = false
    out.coverage.reasonCodes.push(
      mode.status === 'rejected'
        ? 'accountModeUnavailable'
        : 'unsupportedAccountMode',
    )
    out.warnings.push(
      'Account mode is not verified: balances and derived risk are hidden. Only raw default-perpetual position fields are shown.',
    )
  }
  const skew = (a: QueryResult<unknown>, m: QueryResult<unknown>) => {
    const now = Date.now(),
      at = a.source.timestamp ?? a.source.fetchedAt
    return (
      Math.abs(at - m.source.fetchedAt) > 10000 ||
      Math.abs(now - at) > 10000 ||
      now - m.source.fetchedAt > 10000
    )
  }
  let consistent =
    market.status === 'fulfilled' && !skew(account.value, market.value)
  if (market.status === 'fulfilled' && !consistent) {
    const refreshed = await Promise.allSettled([
      client.query('clearinghouseState', { user: ctx.address }, accountSchema, {
        ...ctx,
        force: true,
      }),
      client.query('metaAndAssetCtxs', {}, marketSchema, {
        ...ctx,
        force: true,
      }),
    ])
    if (refreshed[0].status === 'fulfilled') {
      account = refreshed[0]
      out.sources.push(account.value.source)
    }
    if (refreshed[1].status === 'fulfilled') {
      market = refreshed[1]
      out.sources.push(market.value.source)
    }
    consistent =
      account.status === 'fulfilled' &&
      market.status === 'fulfilled' &&
      !skew(account.value, market.value)
  }
  if (account.status !== 'fulfilled')
    throw new ServiceError(
      'accountUnavailable',
      'Account data unavailable',
      502,
      true,
    )
  if (!consistent) {
    out.coverage.complete = false
    out.coverage.reasonCodes.push(
      market.status === 'rejected' ? 'pricesUnavailable' : 'snapshotSkew',
    )
  }
  if (orders.status === 'rejected') {
    out.coverage.complete = false
    out.coverage.reasonCodes.push('ordersUnavailable')
    out.warnings.push(
      'Stop order status is unknown because the order query failed.',
    )
  }
  const known = new Set(
    market.status === 'fulfilled'
      ? market.value.data[0].universe
          .filter((a) => !a.isDelisted)
          .map((a) => a.name)
      : [],
  )
  const raw = account.value.data
  const filtered = {
    ...raw,
    assetPositions: raw.assetPositions.filter((p) =>
      market.status === 'rejected'
        ? !p.position.coin.includes(':') && !p.position.coin.startsWith('@')
        : known.has(p.position.coin),
    ),
  }
  const excluded = raw.assetPositions.length - filtered.assetPositions.length
  if (excluded) {
    out.coverage.complete = false
    out.coverage.reasonCodes.push('excludedUnknownAsset')
  }
  out.coverage.excludedCount = excluded
  const sourceIds = [
    account.value.source.sourceId,
    ...(market.status === 'fulfilled' ? [market.value.source.sourceId] : []),
    ...(orders.status === 'fulfilled' ? [orders.value.source.sourceId] : []),
  ]
  const risk = calculateRisk(
    filtered,
    market.status === 'fulfilled' ? market.value.data : null,
    orders.status === 'fulfilled' && market.status === 'fulfilled'
      ? orders.value.data.filter((o) => known.has(o.coin))
      : null,
    supported,
    consistent,
    sourceIds,
  )
  if (
    risk.positions.some(
      (p) =>
        p.szi === null ||
        p.positionValue === null ||
        p.unrealizedPnl === null ||
        p.liquidationDistance.reason === 'invalidMarkPrice',
    )
  ) {
    out.coverage.complete = false
    out.coverage.reasonCodes.push('invalidPositionFields')
  }
  out.data = {
    role: out.data.role,
    mode: mode.status === 'fulfilled' ? mode.value.data : null,
    modeSupported: supported,
    summary: supported
      ? {
          ...raw.marginSummary,
          withdrawable: raw.withdrawable,
          sourceIds: [account.value.source.sourceId],
        }
      : null,
    summaryReason: supported ? null : 'unsupportedAccountMode',
    ...risk,
    excludedCount: excluded,
    sourceIds,
  }
  out.warnings.push(
    'Withdrawable is not buying power. Configured leverage is not actual account leverage. Margin use excludes potential margin from open orders. Liquidation distance is a snapshot and cross margin changes with other positions and equity. Matching stop orders do not guarantee full position coverage. Snapshots are not atomic.',
  )
  if (!consistent)
    out.warnings.push(
      'Required snapshots are unavailable or more than 10 seconds apart; cross-snapshot derived calculations are disabled.',
    )
  return out
}
