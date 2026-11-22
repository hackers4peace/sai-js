import postgres from 'postgres'
import type { Sql } from 'postgres'

export class Postgres {
  public sql!: Sql

  private readonly connectionString: string

  private readonly tableName: string

  constructor(connectionString: string, tableName: string) {
    this.connectionString = connectionString
    this.tableName = tableName
  }

  init(): void {
    if (!this.sql) {
      this.sql = postgres(this.connectionString, {
        connection: {
          options: '-c client_min_messages=warning',
        },
      })
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
      await adminSql.end()
    }
  }

  /** Ensures the storage table exists. Idempotent. */
  async ensureTable(): Promise<void> {
    this.init()
    await this.sql`
      CREATE TABLE IF NOT EXISTS ${this.sql(this.tableName)} (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL
      )
    `
  }

  async importFromJson(data: Record<string, string | object>): Promise<void> {
    this.init()
    // Keep the table in place: a running CSS server may read it while a test is
    // being seeded (for example the worker's `findAffectedGrantees` activity).
    // The transaction also makes the replacement atomic for those readers.
    await this.ensureTable()
    const entries = Object.entries(data).map(([key, value]) => ({
      key,
      value: JSON.stringify(value),
    }))
    await this.sql.begin(async (tx) => {
      const sql = tx as unknown as typeof this.sql
      await sql`TRUNCATE ${sql(this.tableName)}`
      if (entries.length > 0) {
        await sql`INSERT INTO ${sql(this.tableName)} ${sql(entries as any)}`
      }
    })
  }

  async exportToJson(): Promise<Record<string, string | object>> {
    this.init()
    const rows = await this.sql`SELECT key, value FROM ${this.sql(this.tableName)}`
    return Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)]))
  }

  async seedKeyValue(data: Record<string, string | object>): Promise<void> {
    await this.ensureDatabase()
    await this.importFromJson(data)
  }
}
