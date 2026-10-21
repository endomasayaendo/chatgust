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
  migrate(db);
  return db;
}

/**
 * 後から追加した sessions の列。CREATE TABLE IF NOT EXISTS は既存の表に列を足さないため、
 * 新規 DB も既存 DB も、無い列だけを ALTER TABLE で追加して同じスキーマにそろえる。
 * 既存行は NULL（＝配信情報不明。VOD リンクを出さない）になる。
 */
const SESSION_COLUMNS: [name: string, type: string][] = [
  ["stream_id", "TEXT"],
  ["stream_started_at", "INTEGER"],
  ["vod_id", "TEXT"],
];

function migrate(db: Db): void {
  const existing = new Set(
    (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name)
  );
  for (const [name, type] of SESSION_COLUMNS) {
    if (!existing.has(name)) db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
  }
}
