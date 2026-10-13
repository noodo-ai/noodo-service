import { z } from 'zod'
export const CONTRACT_VERSION = '1'
export const SCOPE = 'hyperliquid:mainnet:default-perpetuals'
export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((v) => v.toLowerCase())
export const createSchema = z
  .object({ observedAddress: addressSchema.nullable().default(null) })
  .strict()
export const addressUpdateSchema = z
  .object({
    observedAddress: addressSchema.nullable(),
    expectedAddressVersion: z.number().int().positive(),
  })
  .strict()
export const messageSchema = z
  .object({
    clientRequestId: z.uuid(),
    text: z.string().trim().min(1),
    expectedAddressVersion: z.number().int().positive(),
  })
  .strict()
export const loginSchema = z
  .object({
    username: z.string().trim().min(1).max(100),
    password: z.string().min(1).max(256),
  })
  .strict()
export const intervals = [
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '8h',
  '12h',
  '1d',
  '3d',
  '1w',
  '1M',
] as const
export const toolSchemas = {
  get_market_overview: z
    .object({
      coin: z.string().min(1).max(32),
      candleInterval: z.enum(intervals).optional(),
    })
    .strict(),
  get_account_overview: z
    .object({ address: addressSchema.optional() })
    .strict(),
  get_recent_fills: z
    .object({
      address: addressSchema.optional(),
      startTime: z.number().int().nonnegative().optional(),
      endTime: z.number().int().nonnegative().optional(),
    })
    .strict()
    .refine(
      (v) => (v.startTime === undefined) === (v.endTime === undefined),
      'Specify both startTime and endTime',
    ),
}
export type ToolName = keyof typeof toolSchemas
export interface Source {
  sourceId: string
  toolCallId: string
  provider: 'hyperliquid'
  queryType: string
  fetchedAt: number
  cacheHit: boolean
  timestamp: number | null
}
export interface Coverage {
  marketScope: string
  observedAddress: string | null
  complete: boolean
  reasonCodes: string[]
  requestedRange?: { startTime: number; endTime: number }
  returnedRange?: { startTime: number; endTime: number } | null
  scannedThrough?: number | null
  sortOrder?: string
  excludedCount?: number
  truncationReasons?: string[]
}
export interface ToolOutput {
  data: Record<string, unknown>
  sources: Source[]
  coverage: Coverage
  warnings: string[]
}
export interface DataCard extends ToolOutput {
  id: string
  kind: ToolName
  sourceIds: string[]
  formulaVersion: string
}
export type RunActivity =
  | {
      type: 'text'
      id: string
      round: number
      phase: 'pending' | 'explanation' | 'final'
      text: string
    }
  | {
      type: 'tool'
      id: string
      name: ToolName | 'unknown'
      status: 'preparing' | 'running' | 'success' | 'partial' | 'failed'
    }
export interface RunResult {
  activity?: RunActivity[]
  text: string
  textStatus: 'final' | 'partial' | 'unavailable'
  dataCards: DataCard[]
  sources: Source[]
  coverage: Coverage[]
  warnings: string[]
}
export interface ApiError {
  code: string
  message: string
  retryable: boolean
}
export class ServiceError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public retryable = false,
  ) {
    super(message)
  }
  toJSON(): ApiError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    }
  }
}
export function publicError(e: unknown): ServiceError {
  if (e instanceof ServiceError) return e
  if (
    e &&
    typeof e === 'object' &&
    'statusCode' in e &&
    typeof e.statusCode === 'number' &&
    e.statusCode >= 400 &&
    e.statusCode < 500
  )
    return new ServiceError(
      'invalidRequest',
      'Request could not be parsed',
      e.statusCode,
    )
  if (e instanceof z.ZodError)
    return new ServiceError(
      'invalidInput',
      'Request does not match the contract',
    )
  if (e instanceof Error && ['AbortError', 'TimeoutError'].includes(e.name))
    return new ServiceError(
      'requestTimeout',
      'Request timed out or was cancelled',
      504,
      true,
    )
  return new ServiceError(
    'internalError',
    'Request could not be completed',
    500,
    true,
  )
}
export function emptyResult(): RunResult {
  return {
    activity: [],
    text: '',
    textStatus: 'unavailable',
    dataCards: [],
    sources: [],
    coverage: [],
    warnings: [],
  }
}
