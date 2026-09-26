import { DatabaseSync } from "node:sqlite"
// Execute the actual production SQL (rather than a mock that always returns a hit).
export function d1(sqlite = new DatabaseSync(":memory:")) {
  const db = {
    sqlite,
    prepare(sql: string) {
      let args: any[] = []
      return {
        bind(...values: any[]) {
          args = values
          return this
        },
        async first() {
          return sqlite.prepare(sql).get(...args) ?? null
        },
        async run() {
          return sqlite.prepare(sql).run(...args)
        },
      }
    },
    async batch(statements: any[]) {
      sqlite.exec("BEGIN")
      try {
        const result = []
        for (const s of statements) result.push(await s.run())
        sqlite.exec("COMMIT")
        return result
      } catch (e) {
        sqlite.exec("ROLLBACK")
        throw e
      }
    },
  }
  return db
}
