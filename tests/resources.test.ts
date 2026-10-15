import { afterEach, expect, it } from 'vitest'
import { Store } from '../src/db/store.js'
import { createServer } from '../src/server.js'
import { loadConfig } from '../src/config.js'
import { tokenHash } from '../src/http/auth.js'
import { ResourceStore } from '../src/db/resources.js'
import {
  metadataSchema,
  USER_RESOURCE_BYTES,
  MAX_RESOURCE_BYTES,
} from '../src/resources/contracts.js'
const origin = 'http://localhost:5173'
const open: { app: Awaited<ReturnType<typeof createServer>>; store: Store }[] =
  []
afterEach(async () => {
  for (const { app, store } of open.splice(0)) {
    await app.close()
    store.close()
  }
})
async function setup() {
  const store = new Store(':memory:')
  for (const user of ['alice', 'bob']) {
    store.sql
      .prepare('INSERT INTO users VALUES(?,?,?,?)')
      .run(user, user, 'unused', Date.now())
    store.sql
      .prepare('INSERT INTO sessions VALUES(?,?,?)')
      .run(tokenHash(user), user, Date.now() + 60000)
  }
  const app = await createServer(
    loadConfig({
      ANTHROPIC_API_KEY: 'test',
      ALLOWED_ORIGINS: origin,
      NODE_ENV: 'development',
      COOKIE_SECURE: 'false',
    }),
    { store, logger: false },
  )
  open.push({ app, store })
  function call(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    user = 'alice',
    payload?: object,
  ) {
    return app.inject({
      method,
      url,
      headers: { cookie: `noodo_session=${user}`, origin },
      payload,
    })
  }
  return { app, store, call }
}
const report = {
  title: 'AI market report',
  summary: 'Funding analysis',
  body: '# Findings\nBTC',
  topic: 'Markets',
}
it('edits and unpublishes maximum-length reports with escaped Unicode JSON bodies', async () => {
  const { app, call } = await setup()
  const body = '研'.repeat(200000)
  const created = await call('POST', '/v1/resources', 'alice', {
    ...report,
    body,
    visibility: 'public',
  })
  expect(created.statusCode).toBe(200)
  const id = created.json().id
  expect((await call('GET', `/v1/resources/${id}`, 'bob')).statusCode).toBe(200)
  const updated = await app.inject({
    method: 'PATCH',
    url: `/v1/resources/${id}`,
    headers: {
      cookie: 'noodo_session=alice',
      origin,
      'content-type': 'application/json',
    },
    payload: JSON.stringify({
      ...report,
      title: 'Edited long report',
      body,
      visibility: 'private',
    }).replaceAll('研', '\\u7814'),
  })
  expect(updated.statusCode).toBe(200)
  expect(updated.json()).toMatchObject({
    title: 'Edited long report',
    body,
    visibility: 'private',
  })
  expect((await call('GET', `/v1/resources/${id}`, 'bob')).statusCode).toBe(404)
  const rejected = await call('PATCH', `/v1/resources/${id}`, 'alice', {
    ...report,
    body: body + 'x',
  })
  expect(rejected.statusCode).toBe(400)
  expect((await call('GET', `/v1/resources/${id}`)).json().body).toBe(body)
})
it('enforces authentication, private ownership, public read-only access and immediate revocation for metadata and files', async () => {
  const { app, call } = await setup()
  expect((await app.inject({ url: '/v1/resources' })).statusCode).toBe(401)
  const created = await call('POST', '/v1/resources', 'alice', {
    ...report,
    files: [
      {
        name: 'data.csv',
        base64: Buffer.from('coin,value\nBTC,1').toString('base64'),
      },
    ],
  })
  expect(created.statusCode).toBe(200)
  const id = created.json().id
  const detail = (await call('GET', `/v1/resources/${id}`)).json()
  const file = `/v1/resources/${id}/files/${detail.files[0].id}`
  expect(detail.visibility).toBe('private')
  for (const path of [`/v1/resources/${id}`, file])
    expect((await call('GET', path, 'bob')).statusCode).toBe(404)
  expect(
    (await call('GET', '/v1/resources?scope=community', 'bob')).json()
      .resources,
  ).toEqual([])
  expect(
    (await call('GET', '/v1/resources?scope=personal', 'bob')).json().resources,
  ).toEqual([])
  expect(
    (
      await call('PATCH', `/v1/resources/${id}`, 'alice', {
        ...report,
        visibility: 'public',
      })
    ).statusCode,
  ).toBe(200)
  expect((await call('GET', `/v1/resources/${id}`, 'bob')).statusCode).toBe(200)
  const downloaded = await call('GET', file, 'bob')
  expect(downloaded.body).toBe('coin,value\nBTC,1')
  expect(downloaded.headers['content-type']).toBe('application/octet-stream')
  expect(downloaded.headers['cache-control']).toBe('private, no-store')
  expect(
    (await call('PATCH', `/v1/resources/${id}`, 'bob', report)).statusCode,
  ).toBe(404)
  expect((await call('DELETE', `/v1/resources/${id}`, 'bob')).statusCode).toBe(
    404,
  )
  await call('PATCH', `/v1/resources/${id}`, 'alice', {
    ...report,
    visibility: 'private',
  })
  expect((await call('GET', file, 'bob')).statusCode).toBe(404)
  await call('DELETE', `/v1/resources/${id}`)
  expect((await call('GET', file)).statusCode).toBe(404)
})
it('keeps categories owner-scoped and preserves resources when a category is deleted', async () => {
  const { call } = await setup()
  const category = (
    await call('POST', '/v1/resource-categories', 'alice', {
      name: 'Strategies',
    })
  ).json()
  expect(
    (
      await call('POST', '/v1/resources', 'bob', {
        ...report,
        categoryId: category.id,
      })
    ).statusCode,
  ).toBe(404)
  expect(
    (
      await call('PATCH', `/v1/resource-categories/${category.id}`, 'bob', {
        name: 'Other',
      })
    ).statusCode,
  ).toBe(404)
  expect(
    (await call('DELETE', `/v1/resource-categories/${category.id}`, 'bob'))
      .statusCode,
  ).toBe(404)
  expect(
    (
      await call('POST', '/v1/resource-categories', 'alice', {
        name: 'Strategies',
      })
    ).statusCode,
  ).toBe(409)
  const resource = (
    await call('POST', '/v1/resources', 'alice', {
      ...report,
      categoryId: category.id,
      visibility: 'public',
    })
  ).json()
  expect(
    (await call('GET', `/v1/resources/${resource.id}`, 'bob')).json()
      .categoryId,
  ).toBeNull()
  await call('DELETE', `/v1/resource-categories/${category.id}`)
  expect(
    (await call('GET', `/v1/resources/${resource.id}`)).json().categoryId,
  ).toBeNull()
})
it('searches metadata literally, filters and paginates, and counts independent public readers over seven days', async () => {
  const { call, store } = await setup()
  const a = (
    await call('POST', '/v1/resources', 'alice', {
      ...report,
      title: '100% report',
      visibility: 'public',
    })
  ).json().id
  const b = (
    await call('POST', '/v1/resources', 'alice', {
      ...report,
      title: 'Other report',
      topic: 'Data',
      visibility: 'public',
    })
  ).json().id
  await call('POST', `/v1/resources/${b}/view`, 'bob', {})
  await call('POST', `/v1/resources/${b}/view`, 'bob', {})
  await call('POST', `/v1/resources/${b}/view`, 'alice', {})
  const popular = (
    await call('GET', '/v1/resources?sort=popular&limit=1', 'bob')
  ).json()
  expect(popular.resources[0].id).toBe(b)
  expect(popular.resources[0].views).toBe(1)
  expect(popular.nextOffset).toBe(1)
  expect(
    (await call('GET', '/v1/resources?search=100%25', 'bob'))
      .json()
      .resources.map((r: { id: string }) => r.id),
  ).toEqual([a])
  expect(
    (await call('GET', '/v1/resources?topic=Markets&format=md', 'bob'))
      .json()
      .resources.map((r: { id: string }) => r.id),
  ).toEqual([a])
  store.sql
    .prepare('UPDATE resource_views SET viewedAt=?')
    .run(Date.now() - 8 * 86400000)
  expect(
    (await call('GET', '/v1/resources?sort=popular', 'bob'))
      .json()
      .resources.every((r: { views: number }) => r.views === 0),
  ).toBe(true)
})
it('rejects unsupported, malformed, empty and oversized content and checks quota atomically on creation and edit', async () => {
  const { call, store } = await setup()
  for (const file of [
    { name: 'index.html', base64: Buffer.from('<html>').toString('base64') },
    { name: 'fake.png', base64: Buffer.from('fake').toString('base64') },
    { name: 'bad.json', base64: Buffer.from('{bad').toString('base64') },
    { name: '../a.txt', base64: 'dGVzdA==' },
    { name: 'a.txt', base64: '!' },
  ]) {
    expect(
      (
        await call('POST', '/v1/resources', 'alice', {
          ...report,
          files: [file],
        })
      ).statusCode,
    ).toBe(400)
  }
  expect(
    (await call('POST', '/v1/resources', 'alice', { title: 'Empty' }))
      .statusCode,
  ).toBe(400)
  const repo = new ResourceStore(store)
  const old = repo.create('alice', metadataSchema.parse(report), [])
  const other = repo.create('alice', metadataSchema.parse(report), [])
  store.sql
    .prepare('UPDATE resources SET bytes=? WHERE id=?')
    .run(USER_RESOURCE_BYTES - old.bytes, other.id)
  expect(() => repo.create('alice', metadataSchema.parse(report), [])).toThrow(
    'storage limit',
  )
  expect(() =>
    repo.update(
      old.id,
      'alice',
      metadataSchema.parse({ ...report, body: report.body + 'more' }),
    ),
  ).toThrow('storage limit')
  store.sql
    .prepare('UPDATE resources SET bytes=? WHERE id=?')
    .run(MAX_RESOURCE_BYTES, other.id)
  expect(() =>
    repo.update(
      other.id,
      'alice',
      metadataSchema.parse({ ...report, body: report.body + 'more' }),
    ),
  ).toThrow('at most 10 MB')
  expect((await call('GET', `/v1/resources/${old.id}`)).json().body).toBe(
    report.body,
  )
})
it('accepts a large UTF-8 attachment without regex stack overflow and returns complete file metadata', async () => {
  const { app, call } = await setup()
  const content = 'x'.repeat(1024 * 1024)
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/v1/resources',
        headers: { cookie: 'noodo_session=alice' },
        payload: report,
      })
    ).statusCode,
  ).toBe(403)
  const created = await call('POST', '/v1/resources', 'alice', {
    title: 'Large data',
    files: [
      { name: 'data.txt', base64: Buffer.from(content).toString('base64') },
    ],
  })
  expect(created.statusCode).toBe(200)
  const resource = created.json()
  expect(resource.files[0].bytes).toBe(content.length)
  expect(
    (
      await call(
        'GET',
        `/v1/resources/${resource.id}/files/${resource.files[0].id}`,
      )
    ).body,
  ).toBe(content)
  const other = (await call('POST', '/v1/resources', 'alice', report)).json()
  expect(
    (
      await call(
        'GET',
        `/v1/resources/${other.id}/files/${resource.files[0].id}`,
      )
    ).statusCode,
  ).toBe(404)
  expect(
    (
      await call('GET', '/v1/resources?scope=personal&categoryId=uncategorized')
    ).json().resources,
  ).toHaveLength(2)
})
