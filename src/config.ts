import { z } from 'zod'
// Fixed snapshot; changing the model is an explicit code change.
export const CLAUDE_MODEL_ID = 'claude-sonnet-4-6' as const
const required = z.string().trim().min(1)
const integer = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback)
const envSchema = z
  .object({
    ANTHROPIC_API_KEY: required,
    NODE_ENV: z
      .enum(['development', 'production', 'test'])
      .default('production'),
    HOST: z.string().default('127.0.0.1'),
    PORT: integer(3001),
    DATABASE_PATH: z.string().default('./data/noodo.sqlite'),
    ALLOWED_ORIGINS: required,
    COOKIE_SECURE: z.enum(['true', 'false']).default('true'),
    USER_DAILY_REQUEST_LIMIT: integer(50),
    GLOBAL_DAILY_TOKEN_LIMIT: integer(1000000),
    HYPERLIQUID_WEIGHT_PER_MINUTE: integer(900).refine(
      (v) => v <= 900,
      'Maximum 900',
    ),
    ANTHROPIC_REQUESTS_PER_MINUTE: integer(30),
    SUPPORTED_ACCOUNT_MODES: z
      .string()
      .default('')
      .refine(
        (v) => ['', 'disabled'].includes(v),
        'Only verified disabled mode is permitted',
      ),
    BACKUP_ENCRYPTION_KEY: z.string().default(''),
  })
  .transform((config) => ({ ...config, CLAUDE_MODEL: CLAUDE_MODEL_ID }))
export type Config = z.infer<typeof envSchema>
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success)
    throw new Error(
      `Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    )
  if (
    parsed.data.COOKIE_SECURE === 'false' &&
    parsed.data.NODE_ENV !== 'development'
  )
    throw new Error('COOKIE_SECURE=false is allowed only in development')
  for (const origin of parsed.data.ALLOWED_ORIGINS.split(',')) {
    const url = new URL(origin.trim())
    if (
      url.origin !== origin.trim() ||
      !['http:', 'https:'].includes(url.protocol)
    )
      throw new Error('ALLOWED_ORIGINS must contain exact HTTP(S) origins')
    if (parsed.data.NODE_ENV === 'production' && url.protocol !== 'https:')
      throw new Error('Production origins must use HTTPS')
  }
  return parsed.data
}
