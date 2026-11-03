// A fake Facebook Graph API plus a fake article page, for tests. Records every request it receives.
import http from 'node:http';
import { createHmac } from 'node:crypto';

export const PAGE_ID = '111222333';
export const TOKEN = 'page-token-abc';
export const APP_SECRET = 'app-secret-xyz';

export function startMock() {
  const state = { requests: [], posts: [], scrapeFails: false, tokenRevoked: false, igLinked: true, nextId: 1 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const form = Object.fromEntries(new URLSearchParams(req.headers['content-type']?.includes('urlencoded') ? raw : ''));
    const entry = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, form };
    state.requests.push(entry);
    const json = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const base = `http://127.0.0.1:${server.address().port}`;

    // Fake article pages
    if (url.pathname === '/blogs/news/new-pack') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<html><head><meta property="og:title" content="Dark Pads &amp; Zebra">
<meta property="og:description" content="Forty patches"><meta property="og:image" content="/img.png"></head></html>`);
    }
    if (url.pathname === '/blogs/news/missing') return json(404, {});

    const m = url.pathname.match(/^\/v25\.0(\/.*)$/);
    if (!m) return json(404, { error: { message: 'Unknown path', code: 803 } });
    const path = m[1];

    if (req.headers.authorization !== `Bearer ${TOKEN}` || state.tokenRevoked) {
      return json(400, { error: { message: 'Error validating access token: Session has expired', type: 'OAuthException', code: 190 } });
    }
    if (entry.query.access_token) return json(400, { error: { message: 'token should not be in the URL', code: 1 } });
    const proof = createHmac('sha256', APP_SECRET).update(TOKEN).digest('hex');
    if (entry.query.appsecret_proof !== proof) return json(400, { error: { message: 'Invalid appsecret_proof', code: 100 } });

    if (path === '/' && req.method === 'POST') {
      if (state.scrapeFails) return json(400, { error: { message: 'scrape unavailable', code: 1 } });
      const link = form.id.replace('https://sound7.test', base);
      const page = await fetch(link).catch(() => null);
      if (!page?.ok) return json(400, { error: { message: 'could not scrape', code: 100 } });
      return json(200, { url: form.id, title: 'Dark Pads & Zebra', description: 'Forty patches', image: [{ url: 'https://sound7.test/img.png' }] });
    }
    if (path === `/${PAGE_ID}/feed` && req.method === 'POST') {
      const id = `${PAGE_ID}_${900 + state.nextId++}`;
      state.posts.unshift({ id, message: form.message || '', link: form.link || '', created_time: '2026-11-03T10:00:00+0000' });
      return json(200, { id });
    }
    if (path === `/${PAGE_ID}/posts` && req.method === 'GET') {
      const limit = Number(entry.query.limit || 25);
      return json(200, {
        data: state.posts.slice(0, limit).map((p) => ({
          id: p.id,
          message: p.message,
          created_time: p.created_time,
          permalink_url: `https://www.facebook.com/soundse7en/posts/pfbid${p.id.split('_')[1]}`,
          ...(p.link ? { attachments: { data: [{ unshimmed_url: p.link, title: 'Dark Pads & Zebra', type: 'share' }] } } : {}),
        })),
      });
    }
    if (path === `/${PAGE_ID}` && req.method === 'GET') {
      if (entry.query.fields.includes('instagram_business_account')) {
        return json(200, state.igLinked ? { id: PAGE_ID, instagram_business_account: { id: '1784', username: 'sound7' } } : { id: PAGE_ID });
      }
      return json(200, { id: PAGE_ID, name: 'SOUND7', link: 'https://www.facebook.com/soundse7en', followers_count: 1234 });
    }
    const post = state.posts.find((p) => `/${p.id}` === path);
    if (post && req.method === 'GET') {
      return json(200, { id: post.id, permalink_url: `https://www.facebook.com/soundse7en/posts/pfbid${post.id.split('_')[1]}` });
    }
    if (post && req.method === 'DELETE') {
      state.posts = state.posts.filter((p) => p !== post);
      return json(200, { success: true });
    }
    return json(400, { error: { message: 'Unsupported request', code: 100, error_subcode: 33 } });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, state, base: `http://127.0.0.1:${server.address().port}` }))
  );
}
