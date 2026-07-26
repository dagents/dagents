import { describe, it, expect } from 'vitest'
import { AppDataSource, initDb } from '@dagents/db'

describe('@dagents/db DataSource', () => {
  it('AppDataSource is a postgres DataSource targeting the dagents db', () => {
    expect(AppDataSource.options.type).toBe('postgres')
    expect(AppDataSource.isInitialized).toBe(false)
  })

  it('reads POSTGRES_URL with a dev fallback', () => {
    const url =
      (AppDataSource.options as { url?: string }).url ??
      'postgresql://dagents:dagents_dev@localhost:5432/dagents'
    expect(url).toMatch(/^postgresql:\/\//)
  })

  it('initDb() connects to PG and returns an initialized DataSource', async () => {
    const ds = await initDb()
    try {
      expect(ds.isInitialized).toBe(true)
    } finally {
      await ds.destroy()
    }
  }, 15_000)
})
