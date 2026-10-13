import { z } from 'zod'
import { Decimal } from 'decimal.js'
Decimal.set({ precision: 60, rounding: Decimal.ROUND_HALF_UP })
export const decimal = z.unknown().transform((value) => {
  if (
    typeof value !== 'string' ||
    !/^-?\d+(\.\d+)?$/.test(value) ||
    value.length > 120
  )
    return null
  try {
    return new Decimal(value).isFinite() ? value : null
  } catch {
    return null
  }
})
const id = z
  .union([
    z.string().regex(/^\d+$/),
    z.number().int().nonnegative().refine(Number.isSafeInteger),
  ])
  .transform(String)
export const roleSchema = z.object({
  role: z.enum(['missing', 'user', 'agent', 'vault', 'subAccount']),
})
export const modeSchema = z.string().max(80)
export const marketSchema = z
  .tuple([
    z.object({
      universe: z.array(
        z.object({
          name: z.string(),
          szDecimals: z.number().int().min(0).max(10),
          isDelisted: z.boolean().optional(),
        }),
      ),
    }),
    z.array(
      z.object({
        markPx: decimal,
        funding: decimal,
        openInterest: decimal,
        dayNtlVlm: decimal,
      }),
    ),
  ])
  .refine(
    (v) => v[0].universe.length === v[1].length,
    'Metadata/context index mismatch',
  )
export const accountSchema = z.object({
  marginSummary: z.object({ accountValue: decimal, totalMarginUsed: decimal }),
  withdrawable: decimal,
  time: z.number().int().nonnegative().optional(),
  assetPositions: z.array(
    z.object({
      position: z.object({
        coin: z.string(),
        szi: decimal,
        positionValue: decimal,
        unrealizedPnl: decimal,
        liquidationPx: decimal,
        marginUsed: decimal,
        leverage: z
          .object({
            type: z.enum(['cross', 'isolated']),
            value: z.number().positive(),
          })
          .nullable()
          .optional(),
      }),
    }),
  ),
})
export const orderSchema = z.object({
  coin: z.string(),
  oid: id,
  side: z.enum(['A', 'B']),
  reduceOnly: z.boolean(),
  isTrigger: z.boolean(),
  triggerCondition: z.string(),
  orderType: z.string(),
  triggerPx: decimal,
  sz: decimal,
})
export const ordersSchema = z.array(orderSchema)
export const fillSchema = z.object({
  coin: z.string(),
  tid: id,
  time: z.number().int().nonnegative(),
  px: decimal,
  sz: decimal,
  dir: z.string(),
  side: z.enum(['A', 'B']),
  closedPnl: decimal,
  fee: decimal,
  feeToken: z.string(),
})
export const fillsSchema = z.array(fillSchema)
export const candleSchema = z.array(
  z.object({
    t: z.number().int(),
    T: z.number().int(),
    s: z.string(),
    i: z.string(),
    o: decimal,
    h: decimal,
    l: decimal,
    c: decimal,
    v: decimal,
    n: z.number().int(),
  }),
)
export type Account = z.infer<typeof accountSchema>
export type Order = z.infer<typeof orderSchema>
export type Market = z.infer<typeof marketSchema>
export type Fill = z.infer<typeof fillSchema>
