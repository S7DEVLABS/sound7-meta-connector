// SOUND7 Meta connector
// A remote MCP server on Cloudflare Workers that lets Claude post to SOUND7's Facebook Page.
// Claude signs in through OAuth; the sign-in page asks for CONNECTOR_PASSPHRASE.

import { OAuthProvider, AuthorizationError, CimdFetchError } from '@cloudflare/workers-oauth-provider';
import { handleMcp } from './mcp.js';

const MAX_FAILED_SIGNINS_PER_HOUR = 10;

const escape = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const html = (body, status = 200, headers = new Headers()) => {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(body, { status, headers });
};

function page(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:30rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a;background:#fafafa}
h1{font-size:1.3rem}.box{background:#fff;border:1px solid #ddd;border-radius:8px;padding:1.2rem}
input[type=password]{width:100%;padding:.6rem;font-size:1rem;box-sizing:border-box;margin:.4rem 0 1rem}
button{padding:.6rem 1.2rem;font-size:1rem;margin-right:.5rem;cursor:pointer}
.warn{background:#fff4e5;border:1px solid #f0b46a;padding:.6rem;border-radius:6px}
.err{color:#b00020;font-weight:600}
@media (prefers-color-scheme:dark){body{background:#151515;color:#eee}.box{background:#202020;border-color:#333}.warn{background:#3a2a10;border-color:#80602a}}
</style></head><body>${inner}</body></html>`;
}

function consentPage(details, handle, error = '') {
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : 'This app registered itself, so its name is not verified.';
  return page(
    'SOUND7 Meta connector',
    `<h1>Connect ${escape(details.clientName)} to SOUND7 on Facebook</h1>
<div class="box">
<p>${origin}</p>
<p>Access will be sent to <strong>${escape(details.redirectHost)}</strong>. Only continue if that is <strong>claude.ai</strong>.</p>
${details.redirectIsLoopback ? '<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>' : ''}
<p>This lets it post to and delete posts from the SOUND7 Facebook Page.</p>
${error ? `<p class="err">${escape(error)}</p>` : ''}
<form method="post">
<input type="hidden" name="handle" value="${escape(handle)}">
<label for="pp">Connector passphrase</label>
<input id="pp" type="password" name="passphrase" autocomplete="current-password" autofocus>
<button name="decision" value="approve">Connect</button>
<button name="decision" value="deny">Cancel</button>
</form></div>`
  );
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

// Compares hashes so the check takes the same time whatever was typed.
async function passphraseMatches(given, expected) {
  if (!expected || expected.length < 12) return false;
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const lockKey = () => `signin-failures:${new Date().toISOString().slice(0, 13)}`;

async function authorize(request, env) {
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === 'GET') {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      return html(consentPage(details, consent.handle), 200, consent.headers);
    }
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    const form = await request.formData();
    const handle = String(form.get('handle') || '');
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }

    const failures = Number((await env.OAUTH_KV.get(lockKey())) || 0);
    if (failures >= MAX_FAILED_SIGNINS_PER_HOUR) {
      return html(page('Locked', '<h1>Too many wrong passphrases</h1><p>Sign-in is locked until the start of the next hour.</p>'), 429);
    }
    if (!(await passphraseMatches(String(form.get('passphrase') || ''), env.CONNECTOR_PASSPHRASE))) {
      await env.OAUTH_KV.put(lockKey(), String(failures + 1), { expirationTtl: 7200 });
      return html(
        page('Wrong passphrase', `<h1>Wrong passphrase</h1><p>Go back to Claude and start connecting again. ${MAX_FAILED_SIGNINS_PER_HOUR - failures - 1} attempts left this hour.</p>`),
        401
      );
    }

    const approved = await oauth.approveConsent(request, handle);
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: 'sound7',
      metadata: {},
      scope: approved.request.scope,
      props: { userId: 'sound7' },
    });
    approved.headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const message = error instanceof AuthorizationError ? error.description : 'This app could not be verified.';
      return html(page('Sign-in problem', `<h1>Sign-in problem</h1><p>${escape(message)}</p><p>Go back to Claude and start connecting again.</p>`), 400);
    }
    throw error;
  }
}

const defaultHandler = {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/authorize') return authorize(request, env);
    if (pathname === '/') return new Response('SOUND7 Meta connector', { headers: { 'Content-Type': 'text/plain' } });
    return new Response('Not found', { status: 404 });
  },
};

const apiHandler = {
  fetch(request, env) {
    return handleMcp(request, env);
  },
};

// The OAuth resource must be this Worker's own URL, which is only known once a request arrives.
const providers = new Map();
function providerFor(origin) {
  if (!providers.has(origin)) {
    providers.set(
      origin,
      new OAuthProvider({
        apiRoute: '/mcp',
        apiHandler,
        defaultHandler,
        authorizeEndpoint: '/authorize',
        tokenEndpoint: '/oauth/token',
        clientRegistrationEndpoint: '/oauth/register',
        clientIdMetadataDocumentEnabled: true,
        scopesSupported: ['meta', 'offline_access'],
        resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
        accessTokenTTL: 3600,
      })
    );
  }
  return providers.get(origin);
}

export default {
  fetch(request, env, ctx) {
    const origin = new URL(request.url).origin;
    return providerFor(origin).fetch(request, env, ctx);
  },
};
