import { Initializer, InternalServerError, createErrorMessage } from '@solid/community-server'
import type { KeyValueStorage } from '@solid/community-server'
import postgres from 'postgres'
import type { Sql } from 'postgres'

export class PostgresKeyValueStorage<T> extends Initializer implements KeyValueStorage<string, T> {
  private initialized = false
  private sql: Sql
  constructor(
    private readonly connectionString: string,
    private readonly tableName: string
  ) {
    super()
  }

  async handle(): Promise<void> {
    if (this.initialized) {
      return
    }
    try {
      await this.ensureDatabase()
      this.sql = postgres(this.connectionString)
      await this.ensureTable()
      this.initialized = true
    } catch (cause: unknown) {
      throw new InternalServerError(
        `Error initializing PostgresKeyValueStorage: ${createErrorMessage(cause)}`,
        { cause }
      )
    }
  }

  /** Ensures the database exists. Idempotent. */
  async ensureDatabase(): Promise<void> {
    const url = new URL(this.connectionString)
    const databaseName = url.pathname.slice(1) // without leading '/'
    // Connect to the maintenance DB to check/create the target DB
    url.pathname = '/postgres' // system database
    const adminSql = postgres(url.toString(), { max: 1 })

    await adminSql`SELECT pg_advisory_lock(hashtext(${databaseName}))`

    try {
      const result = await adminSql`
        SELECT 1 FROM pg_database WHERE datname = ${databaseName}
      `
      if (result.length === 0) {
        await adminSql`CREATE DATABASE ${adminSql(databaseName)}`
      }
    } finally {
      await adminSql`SELECT pg_advisory_unlock(hashtext(${databaseName}))`
    }
  }

  /** Ensures the storage table exists. Idempotent. */
  async ensureTable() {
    await this.sql`SELECT pg_advisory_lock(hashtext(${this.tableName}))`
    try {
      await this.sql`
      CREATE TABLE IF NOT EXISTS ${this.sql(this.tableName)} (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL
      )
    `
    } finally {
      await this.sql`SELECT pg_advisory_unlock(hashtext(${this.tableName}))`
    }
  }

  async get(key: string): Promise<T | undefined> {
    const rows = await this.sql`SELECT value FROM ${this.sql(this.tableName)} WHERE key = ${String(
      key
    )}`
    if (rows.length === 0) return undefined
    return JSON.parse(rows[0].value) as T
  }

  async has(key: string): Promise<boolean> {
    const rows = await this.sql`SELECT 1 FROM ${this.sql(this.tableName)} WHERE key = ${String(
      key
    )} LIMIT 1`
    return rows.length > 0
  }

  async set(key: string, value: T): Promise<this> {
    await this.sql`
      INSERT INTO ${this.sql(this.tableName)} (key, value)
      VALUES (${String(key)}, ${JSON.stringify(value)}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `
    return this
  }

  async delete(key: string): Promise<boolean> {
    const result = await this.sql`DELETE FROM ${this.sql(this.tableName)} WHERE key = ${String(
      key
    )}`

    return (result.count ?? 0) > 0
  }

  /** Async iterator of all entries */
  async *entries(): AsyncIterableIterator<[string, T]> {
    // cursor() exists at runtime, but types are incomplete → cast to any
    const cursor: any = this.sql`
      SELECT key, value FROM ${this.sql(this.tableName)}
    `.cursor(50)

    try {
      for await (const row of cursor as AsyncIterableIterator<any[]>) {
        const key = row[0] as string
        const value = JSON.parse(row[1]) as T
        yield [key, value]
      }
    } finally {
      // Runtime has .close(), but TS doesn't know → cast to any
      await cursor.close()
    }
  }
}
