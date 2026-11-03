// Minimal MCP server over Streamable HTTP: JSON-RPC in, JSON out, no sessions.
import { Facebook, FacebookError } from './facebook.js';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];
const SERVER_INFO = { name: 'sound7-meta', title: 'SOUND7 Meta', version: '1.0.0' };

const INSTRUCTIONS = `Posts to SOUND7's Facebook Page.
Always call facebook_post with publish=false first and show the user the preview. Only call it again with publish=true after the user has approved that exact message and link.
Put the article or product URL in "link", not in the message: Facebook turns it into a card with the page's title, description and image.
Use facebook_recent_posts to check something hasn't already been posted.
Use facebook_page_info to check the connection is working.`;

const TOOLS = [
  {
    name: 'facebook_post',
    title: 'Post to Facebook',
    description:
      'Create a post on the SOUND7 Facebook Page. With publish=false (the default) nothing is posted: it returns a preview with the message, its length and the link card Facebook will show (checked with Facebook\'s own scraper, which also refreshes its cached copy of the page). With publish=true it posts.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Post text.' },
        link: { type: 'string', description: 'Optional https URL. Facebook shows it as a card built from the page\'s title, description and image.' },
        publish: { type: 'boolean', description: 'false (default) previews only. true posts it.', default: false },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'facebook_delete_post',
    title: 'Delete a Facebook post',
    description: 'Delete one of the SOUND7 Page\'s own posts, given its post ID or facebook.com link. Confirm with the user first.',
    inputSchema: {
      type: 'object',
      properties: { post: { type: 'string', description: 'Post ID (PAGEID_POSTID) or facebook.com link to the post.' } },
      required: ['post'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'facebook_recent_posts',
    title: 'Recent Facebook posts',
    description: 'List the SOUND7 Page\'s most recent posts with their text, linked URL, date and post ID.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'facebook_page_info',
    title: 'Facebook Page details',
    description: 'Show which Facebook Page the connector posts as, its follower count and whether an Instagram account is linked. Use it to check the connection works.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

function describePreview(p) {
  const lines = ['PREVIEW ONLY, nothing posted.', '', p.message || '(no message)', '', `Length: ${p.length} characters`];
  if (p.card) {
    lines.push(
      '',
      `Link card (${p.card.source === 'facebook' ? "from Facebook's scraper" : "read from the page's tags"}):`,
      `  Title: ${p.card.title || '(none)'}`,
      `  Description: ${p.card.description || '(none)'}`,
      `  Image: ${p.card.image || '(none)'}`,
      `  Link: ${p.link}`
    );
  }
  if (p.notes.length) lines.push('', 'Notes: ' + p.notes.join('; '));
  return lines.join('\n');
}

async function callTool(name, args, env) {
  const fb = new Facebook(env);
  args = args || {};
  switch (name) {
    case 'facebook_post': {
      if (args.publish !== true) return describePreview(await fb.preparePost(args));
      const r = await fb.createPost(args);
      const lines = [`Posted: ${r.url}`, `Post ID: ${r.id}`];
      if (r.card) lines.push(r.card.image ? 'Link card attached with image.' : 'Link card attached without image.');
      if (r.notes.length) lines.push('Notes: ' + r.notes.join('; '));
      return lines.join('\n');
    }
    case 'facebook_delete_post': {
      const r = await fb.deletePost(args.post);
      return `Deleted post ${r.deleted}.`;
    }
    case 'facebook_recent_posts': {
      const posts = await fb.recentPosts(args.limit ?? 10);
      if (!posts.length) return 'No posts yet.';
      return posts
        .map((p) => `${p.createdAt}  ${p.url}\nID: ${p.id}\n${p.message || '(no text)'}${p.link ? `\nLink: ${p.link}` : ''}`)
        .join('\n\n');
    }
    case 'facebook_page_info': {
      const i = await fb.pageInfo();
      const ig = i.instagram.linked === true
        ? `linked (@${i.instagram.username || 'unknown'}, ID ${i.instagram.id})`
        : i.instagram.linked === false ? 'not linked' : i.instagram.note;
      return [`Page: ${i.name} (ID ${i.id})`, `Link: ${i.link || '(none)'}`, `Followers: ${i.followers ?? 'unknown'}`, `Instagram: ${ig}`].join('\n');
    }
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { rpc: -32602 });
  }
}

async function handleMessage(msg, env) {
  const isRequest = msg && typeof msg === 'object' && msg.jsonrpc === '2.0' && typeof msg.method === 'string';
  if (!isRequest) return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
  const isNotification = !('id' in msg);
  const reply = (result) => (isNotification ? null : { jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => (isNotification ? null : { jsonrpc: '2.0', id: msg.id, error: { code, message } });

  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const { name, arguments: args } = msg.params || {};
      if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
      try {
        const text = await callTool(name, args, env);
        return reply({ content: [{ type: 'text', text }] });
      } catch (e) {
        const text = e instanceof FacebookError ? e.message : `Unexpected error: ${e.message}`;
        if (!(e instanceof FacebookError)) console.error(e);
        return reply({ content: [{ type: 'text', text }], isError: true });
      }
    }
    default:
      if (msg.method.startsWith('notifications/')) return null;
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcp(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400 });
  }
  const batch = Array.isArray(body);
  const results = (await Promise.all((batch ? body : [body]).map((m) => handleMessage(m, env)))).filter(Boolean);
  if (!results.length) return new Response(null, { status: 202 });
  return Response.json(batch ? results : results[0]);
}
