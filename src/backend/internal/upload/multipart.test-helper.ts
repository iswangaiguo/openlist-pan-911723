import { DatabaseSync } from "node:sqlite"

/** D1-shaped bindings executing real SQLite SQL; rewrap sqlite to simulate a cold isolate. */
export function uploadDatabase(sqlite = new DatabaseSync(":memory:")) {
  const db = {
    sqlite,
    withSession(mode: string) {
      if (mode !== "first-primary")
        throw new Error("Uploads must read from the primary")
      return db
    },
    prepare(sql: string) {
      let args: any[] = []
      const execute = () => {
        const stmt = sqlite.prepare(sql)
        if (/^\s*(SELECT|PRAGMA)/i.test(sql) || /RETURNING/i.test(sql)) {
          return { success: true, results: stmt.all(...args) }
        }
        const result = stmt.run(...args)
        return {
          success: true,
          results: [],
          meta: { changes: Number(result.changes) },
        }
      }
      return {
        bind(...values: any[]) {
          args = values
          return this
        },
        async first() {
          return sqlite.prepare(sql).get(...args) ?? null
        },
        async all() {
          return execute()
        },
        async run() {
          return execute()
        },
        execute,
      }
    },
    async batch(statements: any[]) {
      sqlite.exec("BEGIN")
      try {
        const result = statements.map((s) => s.execute())
        sqlite.exec("COMMIT")
        return result
      } catch (error) {
        sqlite.exec("ROLLBACK")
        throw error
      }
    },
  }
  return db
}
