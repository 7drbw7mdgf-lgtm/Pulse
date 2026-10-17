// Minimal D1 stand-in over node:sqlite so tests run the real SQL.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const statement = (sql, params = []) => ({
    sql, params,
    bind: (...values) => statement(sql, values),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    run: async () => { const info = db.prepare(sql).run(...params); return { meta: { changes: Number(info.changes) } }; }
  });
  return {
    raw: db,
    prepare: sql => statement(sql),
    batch: async statements => {
      db.exec('BEGIN');
      try {
        const results = statements.map(s => ({ meta: { changes: Number(db.prepare(s.sql).run(...s.params).changes) } }));
        db.exec('COMMIT');
        return results;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  };
}
