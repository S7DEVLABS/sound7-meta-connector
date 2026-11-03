import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMock, PAGE_ID, TOKEN, APP_SECRET } from './mock-graph.js';
import { Facebook } from '../src/facebook.js';

let mock;
const realFetch = globalThis.fetch;

before(async () => {
  mock = await startMock();
  // Article pages are https in real life; send the fake site's requests to the mock server.
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url ?? String(input);
    return realFetch(url.replace('https://sound7.test', mock.base), init);
  };
});
after(() => {
  globalThis.fetch = realFetch;
  mock.server.close();
});

const env = (over = {}) => ({
  META_GRAPH_BASE: mock.base,
  META_PAGE_ID: PAGE_ID,
  META_PAGE_TOKEN: TOKEN,
  META_APP_SECRET: APP_SECRET,
  ...over,
});
const LINK = 'https://sound7.test/blogs/news/new-pack';

test('missing or wrong config gives a clear error', async () => {
  await assert.rejects(new Facebook(env({ META_PAGE_TOKEN: '' })).recentPosts(), /META_PAGE_TOKEN not set/);
  await assert.rejects(new Facebook(env({ META_PAGE_ID: 'soundse7en' })).recentPosts(), /numeric ID/);
});

test('preview posts nothing and shows Facebook\'s card', async () => {
  const fb = new Facebook(env());
  const p = await fb.preparePost({ message: 'Forty dark pads for Zebra.', link: LINK });
  assert.equal(p.card.source, 'facebook');
  assert.equal(p.card.title, 'Dark Pads & Zebra');
  assert.equal(mock.state.posts.length, 0);
  const scrape = mock.state.requests.find((r) => r.path === '/v25.0/' && r.method === 'POST');
  assert.equal(scrape.form.scrape, 'true');
  assert.equal(scrape.form.id, LINK);
});

test('token is sent in a header with appsecret_proof, never in the URL', async () => {
  for (const r of mock.state.requests.filter((r) => r.path.startsWith('/v25.0'))) {
    assert.equal(r.query.access_token, undefined);
    assert.ok(r.query.appsecret_proof);
    assert.equal(r.headers.authorization, `Bearer ${TOKEN}`);
  }
});

test('card falls back to the page tags when the scraper fails', async () => {
  mock.state.scrapeFails = true;
  try {
    const p = await new Facebook(env()).preparePost({ message: 'x', link: LINK });
    assert.equal(p.card.source, 'page');
    assert.equal(p.card.title, 'Dark Pads & Zebra');
    assert.equal(p.card.image, `${mock.base}/img.png`);
    assert.match(p.notes.join(), /scraper|card check failed/);
  } finally {
    mock.state.scrapeFails = false;
  }
});

test('bad input is refused before anything is sent', async () => {
  const fb = new Facebook(env());
  await assert.rejects(fb.preparePost({}), /needs a message, a link or both/);
  await assert.rejects(fb.preparePost({ message: 'x', link: 'http://sound7.com' }), /https/);
  await assert.rejects(fb.preparePost({ message: 'x'.repeat(63207) }), /63207 characters/);
  await assert.rejects(fb.preparePost({ message: 'x', link: 'https://sound7.test/blogs/news/missing' }), /Could not load .* \(HTTP 404\)/);
});

test('a bare URL in the message gets a note', async () => {
  const p = await new Facebook(env()).preparePost({ message: 'See https://sound7.com/x' });
  assert.match(p.notes.join(), /put it in "link"/);
});

test('post, list, delete by link and by ID', async () => {
  const fb = new Facebook(env());
  const r = await fb.createPost({ message: 'Forty dark pads.', link: LINK });
  assert.match(r.id, new RegExp(`^${PAGE_ID}_\\d+$`));
  assert.match(r.url, /facebook\.com\/soundse7en\/posts\/pfbid/);
  assert.equal(mock.state.posts[0].link, LINK);

  const second = await fb.createPost({ message: 'Text only post' });
  const recent = await fb.recentPosts(5);
  assert.equal(recent.length, 2);
  assert.equal(recent[1].link, LINK);

  assert.deepEqual(await fb.deletePost(r.url), { deleted: r.id }); // pfbid link matched via recent posts
  assert.deepEqual(await fb.deletePost(second.id), { deleted: second.id });
  assert.equal(mock.state.posts.length, 0);
});

test('delete refuses posts from other Pages', async () => {
  await assert.rejects(new Facebook(env()).deletePost('999_123'), /isn't on the SOUND7 Page/);
  await assert.rejects(new Facebook(env()).deletePost('https://example.com/x'), /facebook\.com link/);
});

test('page info reports the linked Instagram account', async () => {
  const i = await new Facebook(env()).pageInfo();
  assert.equal(i.name, 'SOUND7');
  assert.deepEqual(i.instagram, { linked: true, id: '1784', username: 'sound7' });
  mock.state.igLinked = false;
  assert.equal((await new Facebook(env()).pageInfo()).instagram.linked, false);
  mock.state.igLinked = true;
});

test('revoked token explains how to fix it', async () => {
  mock.state.tokenRevoked = true;
  try {
    await assert.rejects(new Facebook(env()).recentPosts(), /expired or been revoked.*META_PAGE_TOKEN/s);
  } finally {
    mock.state.tokenRevoked = false;
  }
});
