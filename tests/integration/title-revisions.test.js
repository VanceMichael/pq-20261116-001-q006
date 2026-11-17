import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeArchive, baseFeed, captureTime, page } from "../helpers.js";
import { NewsArchive } from "../../src/service/archive.js";
import { SCHEMA_V1 } from "../../src/store/database.js";
import { createHttpServer } from "../../src/http/server.js";

const ARTICLE_1 = "https://news.example.test/2026/11-16/article-1.shtml";

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk.toString("utf8"));
  return chunks.join("");
}

test("records each source-side title change as its own revision, including a revert", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page([{ id: 1, title: "甲题" }, { id: 2 }, { id: 3 }]), captureTime(1));
  archive.importSnapshot("daily-main", page([{ id: 1, title: "乙题" }, { id: 2 }, { id: 3 }]), captureTime(2));
  archive.importSnapshot("daily-main", `${page([{ id: 1, title: "甲题" }, { id: 2 }, { id: 3 }])}\n<!-- republished -->`, captureTime(3));
  const article = archive.articles.get("daily-main", ARTICLE_1);
  const history = archive.articleTimeline("daily-main", article.articleId);
  // 甲改乙再改回甲是两次来源变化：三个修订各自指回产生它的已接纳快照，历史不被抹平
  assert.deepEqual(history.titleRevisions.map((rev) => [rev.revisionNo, rev.title, rev.captureId]), [
    [3, "甲题", 3], [2, "乙题", 2], [1, "甲题", 1]
  ]);
  // 当前列表显示最新已接纳标题
  assert.equal(archive.articles.get("daily-main", ARTICLE_1).title, "甲题");
  // 历史快照各自保留采集当时看到的标题
  assert.equal(archive.captureItems("daily-main", 1).items[0].title, "甲题");
  assert.equal(archive.captureItems("daily-main", 2).items[0].title, "乙题");
  assert.equal(archive.captureItems("daily-main", 3).items[0].title, "甲题");
  // 时间线的每个观察点也带当时标题
  assert.deepEqual(history.observations.map((obs) => obs.title), ["甲题", "乙题", "甲题"]);
  // 相邻快照比较把回改报告为标题更正，而不是新增加消失
  const report = archive.feedChanges("daily-main");
  assert.equal(report.counts.added, 0);
  assert.equal(report.counts.omitted, 0);
  assert.equal(report.counts.retitled, 1);
  assert.deepEqual(report.retitled, [{
    canonicalUrl: ARTICLE_1,
    previousTitle: "乙题",
    currentTitle: "甲题",
    sourceIndex: 0,
    observedAt: captureTime(3)
  }]);
});

test("does not create revisions for page replays or unchanged titles", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  const html = page([{ id: 1, title: "稳定题" }, { id: 2 }, { id: 3 }]);
  archive.importSnapshot("daily-main", html, captureTime(1));
  const replay = archive.importSnapshot("daily-main", html, captureTime(2));
  assert.equal(replay.replay, true);
  archive.importSnapshot("daily-main", `${html}\n<!-- same titles, fetched again -->`, captureTime(3));
  const article = archive.listItems("daily-main").items.find((item) => item.canonicalUrl === ARTICLE_1);
  const history = archive.articleTimeline("daily-main", article.articleId);
  assert.equal(history.observationCount, 2);
  assert.deepEqual(history.titleRevisions, [{
    revisionNo: 1,
    title: "稳定题",
    captureId: 1,
    observedAt: captureTime(1)
  }]);
});

test("ignores titles carried by quality-rejected captures", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page([{ id: 1, title: "甲题" }, { id: 2 }, { id: 3 }]), captureTime(1));
  const rejected = archive.importSnapshot("daily-main", page([{ id: 1, title: "乙题" }, { id: 2 }]), captureTime(2));
  assert.equal(rejected.accepted, false);
  assert.match(rejected.reason, /too_few_usable_items/);
  // 被拒绝页面里的标题既不进入当前值，也不进入修订序列
  const article = archive.articles.get("daily-main", ARTICLE_1);
  assert.equal(article.title, "甲题");
  assert.deepEqual(archive.articleTimeline("daily-main", article.articleId).titleRevisions.map((rev) => rev.title), ["甲题"]);
  // 被拒绝的快照没有采集项可展示
  const rejectedCapture = archive.captureItems("daily-main", rejected.captureId);
  assert.equal(rejectedCapture.capture.accepted, false);
  assert.equal(rejectedCapture.items.length, 0);
  // 同一更正随被接纳的快照到达后正常记录
  archive.importSnapshot("daily-main", page([{ id: 1, title: "乙题" }, { id: 2 }, { id: 3 }]), captureTime(3));
  assert.equal(archive.articles.get("daily-main", ARTICLE_1).title, "乙题");
  const revisions = archive.articleTimeline("daily-main", article.articleId).titleRevisions;
  assert.deepEqual(revisions.map((rev) => [rev.revisionNo, rev.title]), [[2, "乙题"], [1, "甲题"]]);
});

test("keeps the current list and CSV export on the latest accepted title", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page([{ id: 1, title: "旧题" }, { id: 2 }, { id: 3 }]), captureTime(1));
  archive.importSnapshot("daily-main", page([{ id: 1, title: "新题" }, { id: 2 }, { id: 3 }]), captureTime(2));
  const list = archive.listItems("daily-main");
  assert.equal(list.items.find((item) => item.canonicalUrl === ARTICLE_1).title, "新题");
  const output = new PassThrough();
  const content = collect(output);
  await archive.exportCsv("daily-main", output);
  output.end();
  const csv = await content;
  assert.match(csv, /"新题","https:\/\/news\.example\.test\/2026\/11-16\/article-1\.shtml"/);
  assert.doesNotMatch(csv, /旧题/);
  // 第一次快照仍保留当时看到的标题
  assert.equal(archive.captureItems("daily-main", 1).items[0].title, "旧题");
  assert.equal(archive.captureItems("daily-main", 1).items[0].currentTitle, "新题");
});

function buildLegacyV1Database(filename) {
  const database = new DatabaseSync(filename);
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(SCHEMA_V1);
  database.exec("PRAGMA user_version = 1");
  const t1 = "2026-11-15T10:00:00.000Z";
  const t2 = "2026-11-15T11:00:00.000Z";
  database.prepare(`INSERT INTO feeds
    (feed_id, base_url, allowed_hosts_json, minimum_items, missing_threshold, last_accepted_at, last_item_count, created_at, updated_at)
    VALUES ('daily-main', 'https://news.example.test/scroll-news/news1.html', '["news.example.test"]', 3, 3, ?, 2, ?, ?)`)
    .run(t2, t1, t1);
  const insertCapture = database.prepare(`INSERT INTO captures
    (capture_id, feed_id, fingerprint, captured_at, accepted, candidate_count, normalized_count, rejected_count, duplicate_count, reason)
    VALUES (?, 'daily-main', ?, ?, 1, 2, 2, 0, 0, NULL)`);
  insertCapture.run(1, "legacy-fp-1", t1);
  insertCapture.run(2, "legacy-fp-2", t2);
  const insertArticle = database.prepare(`INSERT INTO articles
    (article_id, feed_id, canonical_url, title, published_at, first_seen_at, last_seen_at, seen_count,
     missing_streak, visibility, review_state, review_note, review_revision)
    VALUES (?, 'daily-main', ?, ?, NULL, ?, ?, 2, 0, 'visible', ?, ?, ?)`);
  insertArticle.run(1, ARTICLE_1, "现存标题", t1, t2, "confirmed", "升级前已核对", 1);
  insertArticle.run(2, "https://news.example.test/2026/11-16/article-2.shtml", "第二篇", t1, t2, "unreviewed", null, 0);
  const insertItem = database.prepare("INSERT INTO capture_items (capture_id, article_id, source_index) VALUES (?, ?, ?)");
  insertItem.run(1, 1, 0);
  insertItem.run(1, 2, 1);
  insertItem.run(2, 1, 0);
  insertItem.run(2, 2, 1);
  database.prepare(`INSERT INTO review_events (article_id, prior_state, next_state, note, revision, changed_at)
    VALUES (1, 'unreviewed', 'confirmed', '升级前已核对', 1, ?)`).run(t2);
  database.close();
}

test("migrates a pre-v2 database and marks unverifiable historical titles as unknown", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "news-archive-legacy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "archive.sqlite");
  buildLegacyV1Database(filename);
  const archive = new NewsArchive(filename, { clock: () => new Date("2026-11-16T02:00:10.000Z") });
  t.after(() => archive.close());

  assert.equal(archive.database.prepare("PRAGMA user_version").get().user_version, 2);
  // 旧快照里无法证实的历史标题明确表示未知，不用当前值倒填
  const legacy = archive.captureItems("daily-main", 2);
  const legacyFirst = legacy.items.find((item) => item.canonicalUrl === ARTICLE_1);
  assert.equal(legacyFirst.title, null);
  assert.equal(legacyFirst.currentTitle, "现存标题");
  // 升级前没有可证实的标题修订
  const before = archive.articleTimeline("daily-main", 1);
  assert.deepEqual(before.titleRevisions, []);
  assert.deepEqual(before.observations.map((obs) => obs.title), [null, null]);
  // 人工审核的修订序列在迁移后保留并可继续推进
  assert.deepEqual(archive.reviewEvents("daily-main", 1).events.map((event) => event.revision), [1]);
  const reviewed = archive.reviewArticle("daily-main", 1, { state: "withdrawn", expectedRevision: 1, note: "升级后复核" });
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.article.reviewRevision, 2);

  // 升级后的首次接纳为标题建立可证实的基线修订
  const corrected = page([{ id: 1, title: "更正题" }, { id: 2 }, { id: 3 }]);
  const imported = archive.importSnapshot("daily-main", corrected, captureTime(1));
  assert.equal(imported.accepted, true);
  const article = archive.articles.get("daily-main", ARTICLE_1);
  assert.equal(article.title, "更正题");
  const history = archive.articleTimeline("daily-main", 1);
  assert.deepEqual(history.titleRevisions.map((rev) => [rev.revisionNo, rev.title]), [[1, "更正题"]]);
  assert.deepEqual(history.observations.map((obs) => obs.title), ["更正题", null, null]);
  // 跨升级边界的比较：一侧标题未知时保守地不断言标题更正
  const straddling = archive.feedChanges("daily-main");
  assert.equal(straddling.previousCapture.captureId, 2);
  assert.equal(straddling.counts.retitled, 0);
  assert.equal(straddling.counts.added, 1);
  // 升级后边界之内的回改正常报告为标题更正
  archive.importSnapshot("daily-main", page([{ id: 1, title: "回改题" }, { id: 2 }, { id: 3 }]), captureTime(2));
  const followup = archive.feedChanges("daily-main");
  assert.equal(followup.counts.retitled, 1);
  assert.deepEqual(followup.retitled.map((entry) => [entry.previousTitle, entry.currentTitle]), [["更正题", "回改题"]]);
  assert.deepEqual(archive.articleTimeline("daily-main", 1).titleRevisions.map((rev) => [rev.revisionNo, rev.title]), [
    [2, "回改题"], [1, "更正题"]
  ]);
  // 迁移后的数据库仍通过完整性审计
  assert.equal(archive.auditIntegrity().status, "consistent");
});

test("keeps manual review revisions independent from the title revision sequence", async (t) => {
  const { archive } = await makeArchive(t, { clock: () => new Date("2026-11-16T02:00:10.000Z") });
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page([{ id: 1, title: "甲题" }, { id: 2 }, { id: 3 }]), captureTime(1));
  const article = archive.listItems("daily-main").items.find((item) => item.canonicalUrl === ARTICLE_1);
  const first = archive.reviewArticle("daily-main", article.articleId, { state: "confirmed", expectedRevision: 0, note: "核对通过" });
  assert.equal(first.status, 200);
  // 标题更正不消耗人工审核的修订号
  archive.importSnapshot("daily-main", page([{ id: 1, title: "乙题" }, { id: 2 }, { id: 3 }]), captureTime(2));
  const conflict = archive.reviewArticle("daily-main", article.articleId, { state: "withdrawn", expectedRevision: 0 });
  assert.equal(conflict.status, 409);
  const second = archive.reviewArticle("daily-main", article.articleId, { state: "withdrawn", expectedRevision: 1, note: "标题待核" });
  assert.equal(second.status, 200);
  assert.equal(second.article.reviewRevision, 2);
  assert.equal(second.article.title, "乙题");
  const events = archive.reviewEvents("daily-main", article.articleId).events;
  assert.deepEqual(events.map((event) => [event.revision, event.nextState]), [[2, "withdrawn"], [1, "confirmed"]]);
  // 标题修订序列独立且完整
  const history = archive.articleTimeline("daily-main", article.articleId);
  assert.deepEqual(history.titleRevisions.map((rev) => [rev.revisionNo, rev.title]), [[2, "乙题"], [1, "甲题"]]);
});

test("serves per-capture observed fields and title revisions through the API", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page([{ id: 1, title: "甲题" }, { id: 2 }, { id: 3 }]), captureTime(1));
  archive.importSnapshot("daily-main", page([{ id: 1, title: "乙题" }, { id: 2 }, { id: 3 }]), captureTime(2));
  const app = createHttpServer(archive, { host: "127.0.0.1", port: 0, logger: { error() {} } });
  const address = await app.listen();
  t.after(() => app.close());
  const root = `http://127.0.0.1:${address.port}/v1/feeds/daily-main`;
  const firstResponse = await fetch(`${root}/captures/1/items`);
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  assert.equal(first.capture.captureId, 1);
  assert.equal(first.items[0].title, "甲题");
  assert.equal(first.items[0].currentTitle, "乙题");
  const second = await (await fetch(`${root}/captures/2/items`)).json();
  assert.equal(second.items[0].title, "乙题");
  const article = archive.listItems("daily-main").items.find((item) => item.canonicalUrl === ARTICLE_1);
  const history = await (await fetch(`${root}/items/${article.articleId}/history`)).json();
  assert.deepEqual(history.titleRevisions.map((rev) => rev.title), ["乙题", "甲题"]);
  assert.deepEqual(history.observations.map((obs) => obs.title), ["乙题", "甲题"]);
  const missing = await fetch(`${root}/captures/99/items`);
  assert.equal(missing.status, 404);
  const unknownFeed = await fetch(`http://127.0.0.1:${address.port}/v1/feeds/absent/captures/1/items`);
  assert.equal(unknownFeed.status, 404);
});
