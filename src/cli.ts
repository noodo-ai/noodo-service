import {
  randomUUID,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto'
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  mkdtempSync,
  rmSync,
} from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline/promises'
import argon2 from 'argon2'
import { z } from 'zod'
import { Store } from './db/store.js'
const command = process.argv[2],
  path = process.env.DATABASE_PATH ?? './data/noodo.sqlite'
function backupKey() {
  return Buffer.from(
    z
      .string()
      .regex(
        /^[0-9a-fA-F]{64}$/,
        'BACKUP_ENCRYPTION_KEY must be 32 bytes of hex',
      )
      .parse(process.env.BACKUP_ENCRYPTION_KEY),
    'hex',
  )
}
const temporary = mkdtempSync(join(tmpdir(), 'noodo-admin-'))
let store: Store | undefined
try {
  if (command === 'verify') {
    const input = resolve(z.string().min(1).parse(process.argv[3]))
    const bytes = readFileSync(input),
      key = backupKey()
    if (bytes.subarray(0, 6).toString() !== 'NOODO1')
      throw new Error('Invalid backup envelope')
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(6, 18))
    decipher.setAuthTag(bytes.subarray(18, 34))
    const restored = join(temporary, 'restored.sqlite')
    writeFileSync(
      restored,
      Buffer.concat([decipher.update(bytes.subarray(34)), decipher.final()]),
      { mode: 0o600 },
    )
    store = new Store(restored)
    const integrity = store.sql.pragma('integrity_check') as {
      integrity_check: string
    }[]
    if (
      integrity.some((r) => r.integrity_check !== 'ok') ||
      (store.sql.pragma('foreign_key_check') as unknown[]).length
    )
      throw new Error('Backup integrity or foreign key verification failed')
    const running = store.sql
      .prepare("SELECT COUNT(*) AS n FROM runs WHERE status='running'")
      .get() as { n: number }
    store.recover()
    const invalid = store.sql
      .prepare(
        "SELECT COUNT(*) AS n FROM runs WHERE status='running' OR settledTokens IS NULL OR settledAt IS NULL OR settledTokens<0 OR settledTokens>reservedTokens OR (status='completed' AND result IS NULL)",
      )
      .get() as { n: number }
    if (invalid.n)
      throw new Error('Backup quota or terminal-state verification failed')
    const snapshots = store.sql
      .prepare('SELECT result FROM tool_calls WHERE result IS NOT NULL')
      .all() as { result: string }[]
    for (const snapshot of snapshots) {
      const parsed = JSON.parse(snapshot.result)
      if (!Array.isArray(parsed.sources))
        throw new Error('Invalid source snapshot')
    }
    console.log(
      JSON.stringify({
        verified: true,
        recoveredRunningRuns: running.n,
        toolSnapshots: snapshots.length,
        restoredToIndependentDatabase: true,
      }),
    )
  } else {
    store = new Store(path)
    if (command === 'user:create') {
      const username = z.string().trim().min(1).max(100).parse(process.argv[3])
      if (!process.stdin.isTTY)
        throw new Error(
          'Use an interactive terminal to enter a password securely',
        )
      const prompt = createInterface({
        input: process.stdin,
        output: process.stdout,
      })
      let password = ''
      try {
        // Raw input suppresses echo; passwords never appear in arguments, env, or logs.
        prompt.close()
        process.stdout.write('Password (12–256 characters): ')
        process.stdin.setRawMode(true)
        process.stdin.resume()
        password = await new Promise<string>((resolveInput, reject) => {
          let value = ''
          const listener = (chunk: Buffer) => {
            for (const char of chunk.toString()) {
              if (char === '\u0003') {
                process.stdin.off('data', listener)
                reject(new Error('Cancelled'))
                return
              }
              if (char === '\r' || char === '\n') {
                process.stdin.off('data', listener)
                resolveInput(value)
                return
              }
              if (char === '\u007f') {
                value = value.slice(0, -1)
                continue
              }
              value += char
            }
          }
          process.stdin.on('data', listener)
        })
      } finally {
        process.stdin.setRawMode(false)
        process.stdin.pause()
        process.stdout.write('\n')
      }
      z.string().min(12).max(256).parse(password)
      const hash = await argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 1,
      })
      store.sql
        .prepare('INSERT INTO users VALUES(?,?,?,?)')
        .run(randomUUID(), username, hash, Date.now())
      console.log(`Invited user created: ${username}`)
    } else if (command === 'backup') {
      const key = backupKey(),
        out = resolve(
          process.argv[3] ??
            `backups/noodo-${new Date().toISOString().replaceAll(':', '-')}.enc`,
        )
      mkdirSync(dirname(out), { recursive: true, mode: 0o700 })
      const snapshot = join(temporary, 'snapshot.sqlite')
      await store.sql.backup(snapshot)
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, iv),
        encrypted = Buffer.concat([
          cipher.update(readFileSync(snapshot)),
          cipher.final(),
        ])
      writeFileSync(
        out,
        Buffer.concat([
          Buffer.from('NOODO1'),
          iv,
          cipher.getAuthTag(),
          encrypted,
        ]),
        { mode: 0o600, flag: 'wx' },
      )
      for (const file of readdirSync(dirname(out)))
        if (
          /^noodo-.*\.enc$/.test(file) &&
          Date.now() - statSync(join(dirname(out), file)).mtimeMs > 7 * 86400000
        )
          unlinkSync(join(dirname(out), file))
      console.log(`Encrypted online backup saved: ${out}`)
    } else if (command === 'prune')
      console.log(`Expired runs removed: ${store.prune()}`)
    else
      throw new Error(
        'Usage: user:create <username> | backup [output.enc] | verify <backup.enc> | prune',
      )
  }
} catch (e) {
  console.error(
    e instanceof z.ZodError
      ? 'Invalid input or missing configuration'
      : e instanceof Error
        ? e.message
        : 'Admin command failed',
  )
  process.exitCode = 1
} finally {
  store?.close()
  rmSync(temporary, { recursive: true, force: true })
}
