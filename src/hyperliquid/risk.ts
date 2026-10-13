import { Decimal } from 'decimal.js'
import type { Account, Order, Market } from './schemas.js'
export const FORMULA_VERSION = 'risk-v1'
export interface Metric {
  value: string | null
  reason: string | null
  sourceIds: string[]
}
const metric = (
  value: string | null,
  reason: string | null,
  sourceIds: string[],
): Metric => ({ value, reason, sourceIds })
export function calculateRisk(
  account: Account,
  market: Market | null,
  orders: Order[] | null,
  supported: boolean,
  consistent: boolean,
  sourceIds: string[],
) {
  const byCoin = new Map(
    market?.[0].universe.map((a, i) => [
      a.name,
      market[1][i]?.markPx ?? null,
    ]) ?? [],
  )
  const values = account.assetPositions.map((p) => p.position.positionValue)
  const fullValues = values.every((v) => v !== null)
  const total = values.reduce(
    (sum, v) => (v === null ? sum : sum.plus(new Decimal(v).abs())),
    new Decimal(0),
  )
  const summary = account.marginSummary
  const marginReason = !supported
    ? 'unsupportedAccountMode'
    : summary.accountValue === null || summary.totalMarginUsed === null
      ? 'invalidMarginFields'
      : new Decimal(summary.accountValue).lte(0)
        ? 'nonPositiveEquity'
        : null
  const marginUsage = metric(
    marginReason
      ? null
      : new Decimal(summary.totalMarginUsed!)
          .div(summary.accountValue!)
          .toString(),
    marginReason,
    sourceIds,
  )
  const positions = account.assetPositions.map(({ position: p }) => {
    const size = p.szi === null ? null : new Decimal(p.szi)
    const direction =
      size === null || size.isZero() ? null : size.gt(0) ? 'long' : 'short'
    const markPx = byCoin.get(p.coin) ?? null
    const reasons: string[] = []
    const distanceReason = !supported
      ? 'unsupportedAccountMode'
      : !consistent
        ? 'snapshotSkew'
        : !direction
          ? 'unknownDirection'
          : markPx === null || new Decimal(markPx).lte(0)
            ? 'invalidMarkPrice'
            : p.liquidationPx === null || new Decimal(p.liquidationPx).lte(0)
              ? 'unknownLiquidationPrice'
              : null
    const distance = distanceReason
      ? null
      : (direction === 'long'
          ? new Decimal(markPx!).minus(p.liquidationPx!)
          : new Decimal(p.liquidationPx!).minus(markPx!)
        )
          .div(markPx!)
          .toString()
    if (distanceReason) reasons.push(distanceReason)
    else if (new Decimal(distance!).lte(0))
      reasons.push('verifyLiquidationDistanceImmediately')
    const concentrationReason = !supported
      ? 'unsupportedAccountMode'
      : p.positionValue === null
        ? 'invalidPositionValue'
        : total.isZero()
          ? 'noPositions'
          : null
    if (!fullValues) reasons.push('concentrationCoveredValuesOnly')
    const concentration = metric(
      concentrationReason
        ? null
        : new Decimal(p.positionValue!).abs().div(total).toString(),
      concentrationReason,
      sourceIds,
    )
    const related = orders?.filter((o) => o.coin === p.coin) ?? []
    const stops = related.filter(
      (o) =>
        o.reduceOnly &&
        o.isTrigger &&
        o.side === (direction === 'long' ? 'A' : 'B') &&
        /^Stop (Market|Limit)$/.test(o.orderType) &&
        o.triggerPx !== null &&
        new Decimal(o.triggerPx).gt(0) &&
        (direction === 'long' ? /(below|<)/i : /(above|>)/i).test(
          o.triggerCondition,
        ),
    )
    const stopStatus =
      orders === null
        ? 'unknown'
        : stops.length
          ? 'matched'
          : 'notFoundInThisQuery'
    if (stopStatus === 'unknown') reasons.push('stopOrderStatusUnknown')
    if (stopStatus === 'notFoundInThisQuery')
      reasons.push('noMatchingStopInThisQuery')
    return {
      ...p,
      leverage: p.leverage ?? null,
      direction,
      markPx,
      concentration,
      liquidationDistance: metric(distance, distanceReason, sourceIds),
      stopStatus,
      relatedOrders: related,
      matchedStopIds: stops.map((o) => o.oid),
      reasonCodes: reasons,
      sourceIds,
    }
  })
  const attention = [...positions]
    .sort((a, b) => {
      const x = a.liquidationDistance.value,
        y = b.liquidationDistance.value
      if (x === null && y !== null) return -1
      if (x !== null && y === null) return 1
      if (x !== null && y !== null) {
        const cmp = new Decimal(x).cmp(y)
        if (cmp) return cmp
      }
      const cmp = new Decimal(b.concentration.value ?? '0').cmp(
        a.concentration.value ?? '0',
      )
      return cmp || a.coin.localeCompare(b.coin)
    })
    .map((p) => ({
      coin: p.coin,
      reasonCodes: p.reasonCodes,
      liquidationDistance: p.liquidationDistance,
      concentration: p.concentration,
      stopStatus: p.stopStatus,
    }))
  return { marginUsage, positions, attention }
}
