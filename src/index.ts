import type { FastifyInstance } from 'fastify'
import { loadConfig, type Config } from './config.js'
import { startupErrorMessage, type StartupStage } from './startup-errors.js'
let stage: StartupStage = 'configuration'
let server: FastifyInstance | undefined
let config: Config | undefined
try {
  config = loadConfig()
  stage = 'initialization'
  // Native module load failures are also caught and reported without credentials.
  const { createServer } = await import('./server.js')
  server = await createServer(config)
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void server?.close().then(() => process.exit(0))
    })
  stage = 'listen'
  await server.listen({ host: config.HOST, port: config.PORT })
} catch (error) {
  console.error(
    startupErrorMessage(error, {
      stage,
      host: config?.HOST,
      port: config?.PORT,
      nodeVersion: process.version,
      architecture: process.arch,
    }),
  )
  if (server) await server.close().catch(() => {})
  process.exitCode = 1
}
