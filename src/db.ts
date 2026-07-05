import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

/** better-sqlite3 のデータベースハンドル。 */
export type Db = Database.Database;

/**
 * SQLite データベースを開き、振り返り用のスキーマ（sessions / samples）を用意して返す。
 * 保存先ディレクトリが無ければ作成し、WAL モードで書き込みのクラッシュ耐性を確保する。
 * `:memory:` を渡せばインメモリDB（テスト用）になる。
 */
export function openDb(dbPath: string): Db {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT    PRIMARY KEY,
      channel    TEXT    NOT NULL,
      title      TEXT    NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at   INTEGER
    );
    CREATE TABLE IF NOT EXISTS samples (
      session_id TEXT    NOT NULL,
      t          INTEGER NOT NULL,
      rate       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_samples_session ON samples(session_id);
  `);
  return db;
}
