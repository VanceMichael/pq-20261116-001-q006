import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

export const SCHEMA_VERSION = 2;

export const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS feeds (
    feed_id TEXT PRIMARY KEY,
    base_url TEXT NOT NULL,
    allowed_hosts_json TEXT NOT NULL,
    minimum_items INTEGER NOT NULL DEFAULT 3,
    missing_threshold INTEGER NOT NULL DEFAULT 3,
    last_accepted_at TEXT,
    last_item_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS captures (
    capture_id INTEGER PRIMARY KEY,
    feed_id TEXT NOT NULL REFERENCES feeds(feed_id),
    fingerprint TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    accepted INTEGER NOT NULL CHECK(accepted IN (0, 1)),
    candidate_count INTEGER NOT NULL,
    normalized_count INTEGER NOT NULL,
    rejected_count INTEGER NOT NULL,
    duplicate_count INTEGER NOT NULL,
    reason TEXT,
    UNIQUE(feed_id, fingerprint)
  );
  CREATE INDEX IF NOT EXISTS captures_feed_time ON captures(feed_id, captured_at DESC);
  CREATE TABLE IF NOT EXISTS articles (
    article_id INTEGER PRIMARY KEY,
    feed_id TEXT NOT NULL REFERENCES feeds(feed_id),
    canonical_url TEXT NOT NULL,
    title TEXT NOT NULL,
    published_at TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    seen_count INTEGER NOT NULL DEFAULT 1,
    missing_streak INTEGER NOT NULL DEFAULT 0,
    visibility TEXT NOT NULL DEFAULT 'visible' CHECK(visibility IN ('visible', 'quiet')),
    review_state TEXT NOT NULL DEFAULT 'unreviewed' CHECK(review_state IN ('unreviewed', 'confirmed', 'withdrawn')),
    review_note TEXT,
    review_revision INTEGER NOT NULL DEFAULT 0,
    UNIQUE(feed_id, canonical_url)
  );
  CREATE INDEX IF NOT EXISTS articles_feed_visibility ON articles(feed_id, visibility, last_seen_at DESC);
  CREATE TABLE IF NOT EXISTS capture_items (
    capture_id INTEGER NOT NULL REFERENCES captures(capture_id) ON DELETE CASCADE,
    article_id INTEGER NOT NULL REFERENCES articles(article_id),
    source_index INTEGER NOT NULL,
    PRIMARY KEY(capture_id, article_id)
  );
  CREATE TABLE IF NOT EXISTS fetch_attempts (
    attempt_id INTEGER PRIMARY KEY,
    feed_id TEXT NOT NULL REFERENCES feeds(feed_id),
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('accepted', 'rejected', 'not_modified', 'failed')),
    http_status INTEGER,
    attempt_count INTEGER NOT NULL,
    requested_url TEXT NOT NULL,
    final_url TEXT,
    capture_id INTEGER REFERENCES captures(capture_id),
    error_code TEXT,
    error_message TEXT
  );
  CREATE INDEX IF NOT EXISTS fetch_attempts_feed_time ON fetch_attempts(feed_id, attempt_id DESC);
  CREATE TABLE IF NOT EXISTS review_events (
    event_id INTEGER PRIMARY KEY,
    article_id INTEGER NOT NULL REFERENCES articles(article_id),
    prior_state TEXT NOT NULL,
    next_state TEXT NOT NULL,
    note TEXT,
    revision INTEGER NOT NULL,
    changed_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS review_events_article_time ON review_events(article_id, event_id DESC);
`;

// v2 让每次出现记住采集当时看到的字段，并记录标题修订序列。
// 已有 capture_items 行的 title/published_at 保持 NULL：旧快照里无法证实的
// 历史标题明确表示未知，绝不用 articles 当前值倒填成事实。
const SCHEMA_V2 = `
  ALTER TABLE capture_items ADD COLUMN title TEXT;
  ALTER TABLE capture_items ADD COLUMN published_at TEXT;
  CREATE TABLE IF NOT EXISTS article_title_revisions (
    revision_id INTEGER PRIMARY KEY,
    article_id INTEGER NOT NULL REFERENCES articles(article_id) ON DELETE CASCADE,
    revision_no INTEGER NOT NULL,
    title TEXT NOT NULL,
    source_capture_id INTEGER NOT NULL REFERENCES captures(capture_id),
    observed_at TEXT NOT NULL,
    UNIQUE(article_id, revision_no)
  );
  CREATE INDEX IF NOT EXISTS article_title_revisions_article ON article_title_revisions(article_id, revision_no DESC);
`;

export function openDatabase(filename) {
  const path = resolve(filename);
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path, { timeout: 5000 });
  database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  migrate(database);
  return database;
}

export function migrate(database) {
  const version = database.prepare("PRAGMA user_version").get().user_version;
  if (version > SCHEMA_VERSION) throw new Error(`database schema ${version} is newer than supported ${SCHEMA_VERSION}`);
  if (version === SCHEMA_VERSION) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    if (version < 1) database.exec(SCHEMA_V1);
    if (version < 2) database.exec(SCHEMA_V2);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function closeDatabase(database) {
  if (database?.isOpen) database.close();
}
