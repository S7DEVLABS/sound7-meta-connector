// End-to-end test: runs the real Worker in wrangler dev against the fake Graph API,
// goes through Claude's whole sign-in (registration, PKCE, passphrase, token) and calls every tool.
// Run with: npm run test:worker
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { startMock, PAGE_ID, TOKEN, APP_SECRET } from './mock-graph.js';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // wrangler dev's local https certificate is self-signed
const PORT = 8799;
const ORIGIN = `https://127.0.0.1:${PORT}`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const PASSPHRASE = 'correct horse battery staple';

let mock;
let dev;
let token;

before(async () => {
  mock = await startMock();
  rmSync('.wrangler/state', { recursive: true, force: true });
  dev = spawn(
    'npx',
    [
      'wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--local-protocol', 'https',
      // Locally the fake Graph API runs on 127.0.0.1, which the production flag would block.
      '--compatibility-flags', 'nodejs_compat',
      '--var', `META_GRAPH_BASE:${mock.base}`,
      '--var', `META_PAGE_ID:${PAGE_ID}`,
      '--var', `META_PAGE_TOKEN:${TOKEN}`,
      '--var', `META_APP_SECRET:${APP_SECRET}`,
      '--var', `CONNECTOR_PASSPHRASE:${PASSPHRASE}`,
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' } }
  );
  let log = '';
  dev.stdout.on('data', (d) => (log += d));
  dev.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(ORIGIN + '/');
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('wrangler dev did not start:\n' + log);
});

after(() => {
  if (dev) process.kill(-dev.pid, 'SIGTERM'); // wrangler starts workerd as a child; stop the whole group
  mock?.server.close();
});

const b64url = (buf) => buf.toString('base64url');

async function mcp(body, auth = token) {
  const res = await fetch(ORIGIN + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${auth}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 202 ? null : await res.json() };
}

test('landing page and unauthenticated MCP challenge', async () => {
  assert.equal(await (await fetch(ORIGIN + '/')).text(), 'SOUND7 Meta connector');
  const res = await fetch(ORIGIN + '/mcp', { method: 'POST', body: '{}' });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') || '', /resource_metadata=/);
  const meta = await (await fetch(ORIGIN + '/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(meta.resource, ORIGIN + '/mcp');
});

test('full sign-in: wrong passphrase refused, right one issues a token', async () => {
  const reg = await (
    await fetch(ORIGIN + '/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'Claude', token_endpoint_auth_method: 'none' }),
    })
  ).json();
  assert.ok(reg.client_id, JSON.stringify(reg));

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const authUrl = new URL(ORIGIN + '/authorize');
  for (const [k, v] of Object.entries({
    response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge,
    code_challenge_method: 'S256', state: 'st8', resource: ORIGIN + '/mcp', scope: 'meta',
  })) authUrl.searchParams.set(k, v);

  const startPage = async () => {
    const res = await fetch(authUrl);
    const html = await res.text();
    assert.equal(res.status, 200, html);
    assert.match(html, /Only continue if that is <strong>claude\.ai<\/strong>/);
    assert.match(html, /Access will be sent to <strong>claude\.ai<\/strong>/);
    const handle = html.match(/name="handle" value="([^"]+)"/)[1];
    const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    return { handle, cookie };
  };
  const submit = ({ handle, cookie }, passphrase) =>
    fetch(authUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie, Origin: ORIGIN },
      body: new URLSearchParams({ handle, passphrase, decision: 'approve' }),
    });

  const wrong = await submit(await startPage(), 'not the passphrase');
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /9 attempts left/);

  const ok = await submit(await startPage(), PASSPHRASE);
  assert.equal(ok.status, 302, await ok.text());
  const loc = new URL(ok.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, REDIRECT);
  assert.equal(loc.searchParams.get('state'), 'st8');

  const tok = await (
    await fetch(ORIGIN + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: loc.searchParams.get('code'), redirect_uri: REDIRECT,
        client_id: reg.client_id, code_verifier: verifier, resource: ORIGIN + '/mcp',
      }),
    })
  ).json();
  assert.ok(tok.access_token, JSON.stringify(tok));
  token = tok.access_token;
});

test('MCP handshake and tool list', async () => {
  const init = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  assert.equal(init.body.result.serverInfo.name, 'sound7-meta');
  assert.equal((await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const list = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.body.result.tools.map((t) => t.name), ['facebook_post', 'facebook_delete_post', 'facebook_recent_posts', 'facebook_page_info']);
  const bad = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, 'not-a-token');
  assert.equal(bad.status, 401);
});

test('preview posts nothing; publish posts; recent, delete and page info work', async () => {
  const call = (name, args, id) => mcp({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const LINK = 'https://sound7.test/blogs/news/new-pack'; // the fake scraper serves this from the mock

  const preview = await call('facebook_post', { message: 'Forty dark pads for Zebra.', link: LINK }, 10);
  const ptext = preview.body.result.content[0].text;
  assert.match(ptext, /^PREVIEW ONLY/);
  assert.match(ptext, /Title: Dark Pads & Zebra/);
  assert.equal(mock.state.posts.length, 0);

  const empty = await call('facebook_post', { publish: true }, 11);
  assert.equal(empty.body.result.isError, true);

  const posted = await call('facebook_post', { message: 'Forty dark pads for Zebra.', link: LINK, publish: true }, 12);
  assert.equal(posted.body.result.isError, undefined, posted.body.result.content[0].text);
  const id = posted.body.result.content[0].text.match(/Post ID: (\S+)/)[1];
  assert.equal(mock.state.posts.length, 1);

  const recent = await call('facebook_recent_posts', { limit: 5 }, 13);
  assert.match(recent.body.result.content[0].text, /Forty dark pads/);

  const info = await call('facebook_page_info', {}, 14);
  assert.match(info.body.result.content[0].text, /Instagram: linked \(@sound7/);

  const del = await call('facebook_delete_post', { post: id }, 15);
  assert.match(del.body.result.content[0].text, /^Deleted post/);
  assert.equal(mock.state.posts.length, 0);
});

test('sign-in locks after ten wrong passphrases in an hour', async () => {
  // One failure was used above; nine more reach the limit.
  for (let i = 0; i < 9; i++) {
    const page = await fetch(ORIGIN + '/authorize?' + new URLSearchParams({
      response_type: 'code', client_id: 'x', redirect_uri: REDIRECT, code_challenge: 'a'.repeat(43), code_challenge_method: 'S256',
    }));
    await page.text();
    const res = await fetch(ORIGIN + '/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN },
      body: new URLSearchParams({ handle: 'h', passphrase: 'wrong', decision: 'approve' }),
    });
    await res.text();
  }
  const locked = await fetch(ORIGIN + '/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN },
    body: new URLSearchParams({ handle: 'h', passphrase: PASSPHRASE, decision: 'approve' }),
  });
  assert.equal(locked.status, 429);
});
