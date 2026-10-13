import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { selectNode22 } from '../scripts/run-node.mjs'
import { startupErrorMessage } from '../src/startup-errors.js'
const directories: string[] = []
afterEach(() =>
  directories
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true })),
)
const context = {
  stage: 'initialization' as const,
  nodeVersion: 'v22.23.2',
  architecture: 'arm64',
}
describe('runtime selection', () => {
  it('keeps a current Node 22 executable', () =>
    expect(selectNode22('/current/node', '22.23.2', '/missing-nvm')).toBe(
      '/current/node',
    ))
  it('selects the latest installed Node 22 without changing global settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'noodo-runtime-test-'))
    directories.push(root)
    for (const version of ['v22.9.0', 'v22.23.2', 'v26.0.0']) {
      const bin = join(root, 'versions', 'node', version, 'bin')
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, 'node'), 'fixture')
    }
    expect(selectNode22('/global/node', '26.0.0', root)).toBe(
      join(root, 'versions', 'node', 'v22.23.2', 'bin', 'node'),
    )
  })
  it('shows install instructions if Node 22 is unavailable', () =>
    expect(() =>
      selectNode22('/global/node', '26.0.0', '/missing-nvm'),
    ).toThrow('nvm install 22'))
})
describe('safe startup diagnostics', () => {
  it('identifies native runtime/architecture mismatches', () => {
    const error = Object.assign(new Error('incompatible architecture'), {
      code: 'ERR_DLOPEN_FAILED',
    })
    expect(startupErrorMessage(error, context)).toContain('npm ci')
    expect(startupErrorMessage(error, context)).toContain('arm64')
  })
  it('identifies an occupied port', () =>
    expect(
      startupErrorMessage(
        Object.assign(new Error('listen error'), { code: 'EADDRINUSE' }),
        { ...context, stage: 'listen', host: '127.0.0.1', port: 3001 },
      ),
    ).toContain('127.0.0.1:3001 is already in use'))
  it('distinguishes database permissions and locks', () => {
    expect(startupErrorMessage({ code: 'SQLITE_CANTOPEN' }, context)).toContain(
      'DATABASE_PATH',
    )
    expect(startupErrorMessage({ code: 'SQLITE_BUSY' }, context)).toContain(
      'Database is locked',
    )
  })
  it('preserves actionable configuration validation', () =>
    expect(
      startupErrorMessage(
        new Error('COOKIE_SECURE=false is allowed only in development'),
        { ...context, stage: 'configuration' },
      ),
    ).toContain('COOKIE_SECURE'))
  it('does not expose provider credentials or raw unknown error text', () => {
    const output = startupErrorMessage(
      new Error('provider request contains sk-ant-private-value'),
      context,
    )
    expect(output).toContain('initialization')
    expect(output).not.toContain('sk-ant-private-value')
  })
})
