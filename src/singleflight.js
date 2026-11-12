// One upstream pull per identical request (2026-11-12, reliability pass).
//
// Why: every route keeps its own cache, but only AFTER a pull finishes. When
// several people open the dashboard at the same moment, each of them started
// the same Shopify / Triple Whale / Windsor pulls side by side — 4 viewers
// meant 4× the upstream calls, which ran into those services' rate limits
// (429s) and Render's 100 s request limit (502s).
//
// What it does: while a GET /api/... request is being answered, an identical
// request (same path and query string) waits for that answer and gets the
// same response instead of starting its own pull. Nothing is kept once the
// first request has answered — the routes' own caches take over from there.
// A response that isn't JSON (rare) isn't shared: the waiting request then
// runs normally.

const inFlight = new Map(); // url -> Promise<{ status, headers, body } | null>
const SHARED_HEADERS = ['x-month-cache', 'x-month-cache-fetched-at', 'x-data-as-of'];

function singleFlight(req, res, next) {
  if (req.method !== 'GET') return next();
  const key = req.originalUrl;
  const pending = inFlight.get(key);
  if (pending) {
    pending.then((rec) => {
      if (!rec || res.headersSent) return next();
      res.set('X-Shared-Response', '1');
      Object.entries(rec.headers).forEach(([k, v]) => res.set(k, v));
      res.status(rec.status).json(rec.body);
    }, () => next());
    return;
  }
  let settle;
  const promise = new Promise((resolve) => { settle = resolve; });
  inFlight.set(key, promise);
  let done = false;
  const finish = (rec) => {
    if (done) return;
    done = true;
    if (inFlight.get(key) === promise) inFlight.delete(key);
    settle(rec);
  };
  const json = res.json.bind(res);
  res.json = (body) => {
    const headers = {};
    SHARED_HEADERS.forEach((h) => { const v = res.get(h); if (v !== undefined) headers[h] = v; });
    finish({ status: res.statusCode, headers, body });
    return json(body);
  };
  // A viewer who closes the tab doesn't end the pull (the route still answers
  // with res.json), so only a response that finished without JSON — or a
  // pull stuck for 5 minutes — lets the waiting requests run on their own.
  res.on('finish', () => finish(null));
  setTimeout(() => finish(null), 5 * 60 * 1000).unref();
  next();
}

module.exports = { singleFlight };
