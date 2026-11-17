export class ChangeReportService {
  constructor({ feeds, captures, articles }) {
    this.feeds = feeds;
    this.captures = captures;
    this.articles = articles;
  }

  report(feedId) {
    const feed = this.feeds.get(feedId);
    if (!feed) return null;
    const [current, previous] = this.captures.acceptedPair(feedId);
    if (!current || !previous) {
      return {
        feedId,
        ready: false,
        reason: "two accepted captures are required",
        latestCapture: current ?? null,
        previousCapture: previous ?? null,
        added: [],
        omitted: [],
        retitled: [],
        counts: { added: 0, omitted: 0, retitled: 0, current: current?.normalizedCount ?? 0, previous: 0 }
      };
    }
    const before = this.articles.forCapture(previous.captureId);
    const after = this.articles.forCapture(current.captureId);
    const previousByUrl = new Map(before.map((article) => [article.canonicalUrl, article]));
    const currentUrls = new Set(after.map((article) => article.canonicalUrl));
    const added = after.filter((article) => !previousByUrl.has(article.canonicalUrl));
    const omitted = before.filter((article) => !currentUrls.has(article.canonicalUrl));
    // 同一篇文章在两次快照中都出现、且两次采集到的标题都可证实且不同，才算标题更正；
    // 任一侧标题未知（升级前快照）时保守地不断言变化。
    const retitled = after
      .map((article) => ({ article, prior: previousByUrl.get(article.canonicalUrl) }))
      .filter(({ article, prior }) => prior && prior.title !== null && article.title !== null && prior.title !== article.title)
      .map(({ article, prior }) => ({
        canonicalUrl: article.canonicalUrl,
        previousTitle: prior.title,
        currentTitle: article.title,
        sourceIndex: article.sourceIndex,
        observedAt: current.capturedAt
      }));
    return {
      feedId,
      ready: true,
      latestCapture: summarizeCapture(current),
      previousCapture: summarizeCapture(previous),
      added: added.map((article) => compactArticle(article, current.capturedAt)),
      omitted: omitted.map((article) => compactArticle(article, current.capturedAt)),
      retitled,
      counts: { added: added.length, omitted: omitted.length, retitled: retitled.length, current: after.length, previous: before.length },
      note: "Omission means absent from this listing capture, not that the publisher deleted the article. " +
        "Retitled entries appeared in both captures under different captured titles."
    };
  }
}

function summarizeCapture(capture) {
  return {
    captureId: capture.captureId,
    capturedAt: capture.capturedAt,
    itemCount: capture.normalizedCount
  };
}

function compactArticle(article, observedAt) {
  return {
    canonicalUrl: article.canonicalUrl,
    title: article.title,
    currentTitle: article.currentTitle,
    publishedAt: article.publishedAt,
    sourceIndex: article.sourceIndex,
    observedAt,
    currentVisibility: article.visibility
  };
}
