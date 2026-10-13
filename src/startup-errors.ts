export type StartupStage = 'configuration' | 'initialization' | 'listen'
export interface StartupContext {
  stage: StartupStage
  host?: string
  port?: number
  nodeVersion: string
  architecture: string
}
export function startupErrorMessage(
  error: unknown,
  context: StartupContext,
): string {
  const message = error instanceof Error ? error.message : ''
  const code =
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : ''
  if (context.stage === 'configuration') {
    const safePrefixes = [
      'Invalid configuration:',
      'COOKIE_SECURE=false is allowed only in development',
      'ALLOWED_ORIGINS must contain exact HTTP(S) origins',
      'Production origins must use HTTPS',
    ]
    if (safePrefixes.some((prefix) => message.startsWith(prefix)))
      return message
    return 'Invalid service configuration. Check .env, including ALLOWED_ORIGINS.'
  }
  if (code === 'EADDRINUSE')
    return `Service startup failed: ${context.host ?? 'configured host'}:${context.port ?? 'configured port'} is already in use. Stop the previous noodo-service process or change PORT.`
  if (
    code === 'ERR_DLOPEN_FAILED' ||
    /NODE_MODULE_VERSION|incompatible architecture|another platform|Could not locate the bindings file/.test(
      message,
    )
  )
    return `Native dependencies do not match Node ${context.nodeVersion} (${context.architecture}). Run nvm use and npm ci in noodo-service, then npm run dev. The database does not need to be deleted.`
  if (['EACCES', 'EPERM', 'SQLITE_CANTOPEN', 'SQLITE_READONLY'].includes(code))
    return context.stage === 'listen'
      ? 'Service cannot listen on the configured HOST/PORT. Check the bind address and port permissions.'
      : 'Database or migration files are inaccessible. Check DATABASE_PATH and directory/file permissions.'
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED')
    return 'Database is locked. Check for another service or database maintenance process.'
  if (code.startsWith('SQLITE_'))
    return 'Database initialization or migration failed. Check the database and migrations; preserve the database before making changes.'
  if (code === 'ENOENT')
    return 'A required service file is missing. Check DATABASE_PATH and the migrations directory.'
  // Never echo an unclassified provider error, stack trace, environment value or credential.
  return `Service startup failed during ${context.stage}. Node ${context.nodeVersion} (${context.architecture}); check service files and installed dependencies.`
}
