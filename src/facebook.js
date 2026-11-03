// Facebook Pages client for the SOUND7 connector (Graph API).
// Plain fetch, no SDK, so it runs on Workers and in Node tests unchanged.
//
// It acts only as the SOUND7 Page, using a Page access token. It can post to the Page's feed,
// list the Page's own posts, delete the Page's own posts and read basic Page details. Nothing else.

import { fetchCard } from './card.js';

const GRAPH = 'https://graph.facebook.com';
const DEFAULT_VERSION = 'v26.0';
export const MAX_MESSAGE = 63206; // Facebook's limit for a Page post

export class FacebookError extends Error {}

const SECRET_HELP = "Update it in the Cloudflare Worker sound7-meta under Settings, Variables and Secrets.";

// Turns a Graph API error into something Martyn can act on.
function explain(err, status) {
  const code = err?.code;
  const msg = err?.message || `HTTP ${status}`;
  if (code === 190 || code === 102) {
    return `Facebook rejected the Page token (code ${code}: ${msg}). It has expired or been revoked, often after a Facebook password change. Generate a new Page token and set META_PAGE_TOKEN. ${SECRET_HELP}`;
  }
  if (code === 10 || code === 200 || (code >= 200 && code < 300)) {
    return `Facebook says the token is missing a permission (code ${code}: ${msg}). The Page token needs pages_manage_posts, pages_read_engagement and pages_show_list.`;
  }
  if ([4, 17, 32, 613, 80001].includes(code)) {
    return `Facebook rate limit reached (code ${code}). Wait a while and try once more; don't retry in a loop.`;
  }
  if (code === 368) {
    return `Facebook blocked this action as possible spam or a policy issue (code 368: ${msg}). Check the Page's notifications in Facebook.`;
  }
  if (code === 100 && err?.error_subcode === 33) {
    return `That post doesn't exist, or the token can't see it (${msg}).`;
  }
  return `Facebook error${code ? ` (code ${code})` : ''}: ${msg}`;
}

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export class Facebook {
  constructor(env) {
    this.base = (env.META_GRAPH_BASE || GRAPH).replace(/\/$/, '');
    this.version = env.META_API_VERSION || DEFAULT_VERSION;
    this.pageId = (env.META_PAGE_ID || '').trim();
    this.token = (env.META_PAGE_TOKEN || '').trim();
    this.appSecret = (env.META_APP_SECRET || '').trim();
  }

  checkConfig() {
    const missing = [];
    if (!this.pageId) missing.push('META_PAGE_ID');
    if (!this.token) missing.push('META_PAGE_TOKEN');
    if (missing.length) throw new FacebookError(`${missing.join(' and ')} not set. ${SECRET_HELP}`);
    if (!/^\d+$/.test(this.pageId)) throw new FacebookError(`META_PAGE_ID should be the Page's numeric ID, not its name. ${SECRET_HELP}`);
  }

  // appsecret_proof ties each call to SOUND7's Meta app, so a leaked token alone is less useful.
  async proof() {
    if (!this.appSecret) return null;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(this.appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(this.token)));
  }

  async graph(method, path, { params = {}, form } = {}) {
    this.checkConfig();
    const url = new URL(`${this.base}/${this.version}/${path.replace(/^\//, '')}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
    const proof = await this.proof();
    if (proof) url.searchParams.set('appsecret_proof', proof);
    // The token goes in a header, never in the URL, so it can't end up in logs.
    const headers = { Authorization: `Bearer ${this.token}` };
    let body;
    if (form) {
      body = new URLSearchParams(Object.entries(form).filter(([, v]) => v !== undefined && v !== ''));
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    let res;
    try {
      res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(20000) });
    } catch (e) {
      throw new FacebookError(`Could not reach Facebook: ${e.message}`);
    }
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new FacebookError(`Facebook sent an unreadable reply (HTTP ${res.status}).`);
    }
    if (!res.ok || data.error) throw new FacebookError(explain(data.error, res.status));
    return data;
  }

  // ---------- posting ----------

  validate({ message, link }) {
    message = typeof message === 'string' ? message.trim() : '';
    link = typeof link === 'string' ? link.trim() : '';
    if (!message && !link) throw new FacebookError('A post needs a message, a link or both.');
    if (message.length > MAX_MESSAGE) throw new FacebookError(`The message is ${message.length} characters; Facebook allows ${MAX_MESSAGE}.`);
    if (link) {
      let u;
      try {
        u = new URL(link);
      } catch {
        throw new FacebookError(`"${link}" isn't a valid URL.`);
      }
      if (u.protocol !== 'https:') throw new FacebookError('The link must be an https URL.');
    }
    return { message, link };
  }

  // What Facebook will show as the link card. Asks Facebook's own scraper first, which also
  // refreshes Facebook's cached copy of the page so the card is current. Falls back to reading
  // the page's tags directly.
  async linkCard(link) {
    try {
      const og = await this.graph('POST', '/', { form: { id: link, scrape: 'true' } });
      const image = Array.isArray(og.image) ? og.image[0]?.url : og.image?.url || og.image;
      return { source: 'facebook', title: og.title || '', description: og.description || '', image: image || '', url: og.url || link };
    } catch (e) {
      const page = await fetchCard(link).catch(() => ({ ok: false }));
      if (!page.ok) throw new FacebookError(`Could not load ${link} for the link card${page.status ? ` (HTTP ${page.status})` : ''}. Check the page is published.`);
      return { source: 'page', title: page.title, description: page.description, image: page.image, url: link, scrapeError: e.message };
    }
  }

  async preparePost(args) {
    const { message, link } = this.validate(args);
    const notes = [];
    let card = null;
    if (link) {
      card = await this.linkCard(link);
      if (card.source === 'page') notes.push(`Facebook's own card check failed (${card.scrapeError}), so this card is read from the page's tags and may differ slightly`);
      if (!card.image) notes.push('the card has no image; the page has no og:image');
      if (message.includes(link)) notes.push('the link is also in the message text; Facebook usually hides it once the card shows, but it can look doubled');
    }
    const bareUrls = (message.match(/https?:\/\/\S+/g) || []).filter((u) => u !== link);
    if (!link && bareUrls.length) notes.push('the message contains a URL but no link was given; put it in "link" for a proper card');
    return { message, link, length: message.length, card, notes };
  }

  async createPost(args) {
    const prepared = await this.preparePost(args);
    const r = await this.graph('POST', `/${this.pageId}/feed`, { form: { message: prepared.message, link: prepared.link } });
    if (!r.id) throw new FacebookError('Facebook did not return a post ID, so the post may not have gone out. Check the Page before retrying.');
    let url = `https://www.facebook.com/${r.id}`;
    try {
      const p = await this.graph('GET', `/${r.id}`, { params: { fields: 'permalink_url' } });
      if (p.permalink_url) url = p.permalink_url;
    } catch {
      /* the short link above still works */
    }
    return { id: r.id, url, notes: prepared.notes, card: prepared.card };
  }

  // ---------- reading and deleting ----------

  async recentPosts(limit = 10) {
    limit = Math.max(1, Math.min(50, Number(limit) || 10));
    const r = await this.graph('GET', `/${this.pageId}/posts`, {
      params: { fields: 'id,message,created_time,permalink_url,attachments{unshimmed_url,url,title,type}', limit },
    });
    return (r.data || []).map((p) => {
      const a = p.attachments?.data?.[0];
      return {
        id: p.id,
        createdAt: p.created_time,
        url: p.permalink_url || `https://www.facebook.com/${p.id}`,
        message: p.message || '',
        link: a?.unshimmed_url || '',
        cardTitle: a?.title || '',
      };
    });
  }

  // Accepts a post ID ("PAGEID_POSTID") or a facebook.com link to the post.
  async resolvePostId(input) {
    input = String(input || '').trim();
    if (!input) throw new FacebookError('Give the post\'s ID or its facebook.com link.');
    if (/^\d+_\d+$/.test(input)) return input;
    if (/^\d+$/.test(input)) return `${this.pageId}_${input}`;
    let u;
    try {
      u = new URL(input);
    } catch {
      throw new FacebookError(`"${input}" isn't a post ID or a facebook.com link.`);
    }
    if (!/(^|\.)facebook\.com$/.test(u.hostname)) throw new FacebookError('That isn\'t a facebook.com link.');
    const direct = u.pathname.match(/^\/(\d+_\d+)\/?$/)?.[1] || u.searchParams.get('story_fbid') && `${this.pageId}_${u.searchParams.get('story_fbid')}`;
    if (direct && /^\d+_\d+$/.test(direct)) return direct;
    const numeric = u.pathname.match(/\/posts\/(\d+)\/?$/)?.[1];
    if (numeric) return `${this.pageId}_${numeric}`;
    // pfbid links can't be decoded, so match them against the Page's recent posts.
    const norm = (s) => s.replace(/^https?:\/\/(www\.|m\.)?facebook\.com/, '').replace(/\/$/, '');
    const match = (await this.recentPosts(50)).find((p) => norm(p.url) === norm(u.origin + u.pathname));
    if (match) return match.id;
    throw new FacebookError('Couldn\'t find that post among the Page\'s 50 most recent posts. Use facebook_recent_posts to get its ID.');
  }

  async deletePost(input) {
    const id = await this.resolvePostId(input);
    if (!id.startsWith(`${this.pageId}_`)) throw new FacebookError('That post isn\'t on the SOUND7 Page, so it won\'t be deleted.');
    const r = await this.graph('DELETE', `/${id}`);
    if (r.success !== true) throw new FacebookError(`Facebook didn't confirm the delete of ${id}.`);
    return { deleted: id };
  }

  // Basic Page details, used to check the token is right. Also says whether an Instagram
  // account is linked, which is what the Instagram tools will need later.
  async pageInfo() {
    const page = await this.graph('GET', `/${this.pageId}`, { params: { fields: 'id,name,link,followers_count' } });
    let instagram;
    try {
      const ig = await this.graph('GET', `/${this.pageId}`, { params: { fields: 'instagram_business_account{id,username}' } });
      instagram = ig.instagram_business_account
        ? { linked: true, id: ig.instagram_business_account.id, username: ig.instagram_business_account.username || '' }
        : { linked: false };
    } catch (e) {
      instagram = { linked: null, note: `couldn't check (${e.message})` };
    }
    return { id: page.id, name: page.name, link: page.link, followers: page.followers_count, instagram };
  }
}
