import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { Store } from '../src/db/store.js'
import { loadConfig } from '../src/config.js'
import { emptyResult } from '../src/contracts.js'
const exec = promisify(execFile),
  paths: string[] = []
afterEach(() =>
  paths.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })),
)
it('backs up an active WAL database, verifies encrypted independent restore, and leaves live data untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'noodo-backup-test-'))
  paths.push(dir)
  const store = new Store(join(dir, 'live.sqlite')),
    owner = randomUUID()
  try {
    store.sql
      .prepare('INSERT INTO users VALUES(?,?,?,?)')
      .run(owner, owner, 'hash', Date.now())
    const c = store.create(owner, null),
      config = loadConfig({
        ANTHROPIC_API_KEY: 'test',
        CLAUDE_MODEL: 'test',
        ALLOWED_ORIGINS: 'http://localhost:5173',
        NODE_ENV: 'development',
        COOKIE_SECURE: 'false',
      })
    const run = store.accept(
      c.id,
      owner,
      {
        clientRequestId: randomUUID(),
        text: 'private fixture text',
        expectedAddressVersion: 1,
      },
      config,
    ).run
    store.checkpoint(
      run.id,
      { ...emptyResult(), text: 'partial persisted', textStatus: 'partial' },
      { input: 5, output: 1, unconfirmed: 0 },
    )
    const out = join(dir, 'noodo-test.enc'),
      env = {
        ...process.env,
        DATABASE_PATH: join(dir, 'live.sqlite'),
        BACKUP_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      }
    await exec(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'backup', out],
      { env },
    )
    const encrypted = readFileSync(out)
    expect(encrypted.subarray(0, 6).toString()).toBe('NOODO1')
    expect(encrypted.includes(Buffer.from('private fixture text'))).toBe(false)
    const result = await exec(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'verify', out],
      { env },
    )
    expect(JSON.parse(result.stdout).verified).toBe(true)
    expect(JSON.parse(result.stdout).recoveredRunningRuns).toBe(1)
    expect(store.run(run.id, owner).status).toBe('running')
    await expect(
      exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'verify', out], {
        env: { ...env, BACKUP_ENCRYPTION_KEY: randomBytes(32).toString('hex') },
      }),
    ).rejects.toThrow()
  } finally {
    store.close()
  }
})
