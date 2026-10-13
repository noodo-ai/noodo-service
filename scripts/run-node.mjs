import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

/** @param {string} executable @param {string} version @param {string} nvmRoot @returns {string} */
export function selectNode22(executable, version, nvmRoot) {
  if (/^v?22\./.test(version)) return executable
  const versions = join(nvmRoot, 'versions', 'node')
  const installed = existsSync(versions)
    ? readdirSync(versions)
        .filter((name) => /^v22\.\d+\.\d+$/.test(name))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    : []
  const candidate = installed
    .map((name) => join(versions, name, 'bin', 'node'))
    .find(existsSync)
  if (!candidate)
    throw new Error(
      'Node.js 22 is required. Run nvm install 22 and nvm use, then npm ci.',
    )
  return candidate
}

function run() {
  let executable
  try {
    executable = selectNode22(
      process.execPath,
      process.versions.node,
      process.env.NVM_DIR ?? join(homedir(), '.nvm'),
    )
    const checked = spawnSync(executable, ['-p', 'process.versions.node'], {
      encoding: 'utf8',
    })
    if (checked.status !== 0 || !/^22\./.test(checked.stdout?.trim() ?? ''))
      throw new Error(
        'The selected Node.js 22 executable could not run. Run nvm use and npm ci.',
      )
    if (executable !== process.execPath)
      console.log(`Using Node.js ${checked.stdout.trim()} for noodo-service.`)
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : 'Node.js 22 could not be selected.',
    )
    process.exitCode = 1
    return
  }
  // Child commands such as native-module tooling must use the same runtime.
  const child = spawn(executable, process.argv.slice(2), {
    stdio: 'inherit',
    env: {
      ...process.env,
      PATH: `${dirname(executable)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
    },
  })
  const interrupt = () => child.kill('SIGINT')
  const terminate = () => child.kill('SIGTERM')
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  child.once('error', () => {
    console.error('Node.js 22 could not start the service command.')
    process.exitCode = 1
  })
  child.once('exit', (code, signal) => {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1)
  })
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  run()
