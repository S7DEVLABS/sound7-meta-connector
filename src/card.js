// Reads a page's Open Graph tags, the same tags Facebook uses to build a link card.
// Used as a fallback preview when Facebook's own scraper can't be asked.

const PAGE_FETCH_LIMIT = 2_000_000;

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function metaContent(html, names) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const name of names) {
    for (const tag of tags) {
      const key = tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i);
      if (!key || key[1].toLowerCase() !== name) continue;
      const val = tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      if (val) return decodeEntities((val[1] ?? val[2]).trim());
    }
  }
  return '';
}

export function parseCardMeta(html, pageUrl) {
  const title =
    metaContent(html, ['og:title', 'twitter:title']) ||
    decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim());
  const description = metaContent(html, ['og:description', 'twitter:description', 'description']);
  let image = metaContent(html, ['og:image:secure_url', 'og:image', 'twitter:image']);
  if (image) {
    try {
      image = new URL(image, pageUrl).toString();
    } catch {
      image = '';
    }
  }
  return { title, description, image };
}

async function readCapped(res, limit) {
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// Returns { ok, status, title, description, image }.
export async function fetchCard(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: { Accept: 'text/html', 'User-Agent': 'SOUND7-Meta-Connector/1.0' },
    redirect: 'follow',
  });
  if (!res.ok) return { ok: false, status: res.status };
  const bytes = await readCapped(res, PAGE_FETCH_LIMIT);
  const html = bytes ? new TextDecoder().decode(bytes) : '';
  return { ok: true, status: res.status, ...parseCardMeta(html, res.url || url) };
}
