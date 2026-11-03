# SOUND7 Meta connector

A remote MCP server on Cloudflare Workers that lets Claude post to the SOUND7 Facebook Page. Instagram tools will be added here later, using the same Meta app and token.

## Tools

- **facebook_post**: previews by default (`publish: false`), showing the message, its length and the link card. The card is checked with Facebook's own scraper, which also refreshes Facebook's cached copy of the page, so the card matches what will be posted. With `publish: true` it posts.
- **facebook_recent_posts**: lists the Page's recent posts, for checking something hasn't already gone out.
- **facebook_delete_post**: deletes one of the Page's own posts by ID or facebook.com link. Refuses posts from other Pages.
- **facebook_page_info**: shows which Page the connector posts as and whether an Instagram account is linked. Use it to check the token.

Claude connects through OAuth. The sign-in page asks for `CONNECTOR_PASSPHRASE`; ten wrong attempts lock sign-in for the rest of that hour.

The Page token is sent in a request header, never in a URL, and every call carries an `appsecret_proof` when `META_APP_SECRET` is set, so the token can't be used from outside SOUND7's Meta app.

## Files

- `src/index.js`: entry point, OAuth setup and the passphrase sign-in page
- `src/mcp.js`: the MCP endpoint and tool definitions
- `src/facebook.js`: Graph API client: posting, link cards, recent posts, delete, Page info
- `src/card.js`: reads a page's Open Graph tags (fallback card preview)
- `test/`: a fake Graph API, client tests and an end-to-end Worker test
- `wrangler.jsonc`: Worker name, KV binding and compatibility flag

## Cloudflare setup

- **KV namespace** `sound7-meta-oauth`, bound as `OAUTH_KV` (ID in `wrangler.jsonc`).
- **Secrets**, set in the dashboard under Settings, Variables and Secrets, type Secret:
  - `META_PAGE_ID`: the SOUND7 Page's numeric ID
  - `META_PAGE_TOKEN`: a Page access token, fetched with a long-lived user token so it doesn't expire (see below)
  - `META_APP_SECRET`: the Meta app's App Secret
  - `CONNECTOR_PASSPHRASE`: at least 12 characters
- **Optional variable** `META_API_VERSION` (default `v26.0`) to move to a newer Graph API version without a code change.
- **Builds**: the Worker is connected to this repo. Every push to `main` runs `npx wrangler deploy`. Secrets live only in Cloudflare and survive deploys.

Connect in Claude with the Worker URL plus `/mcp`.

## Meta app and token

The Meta app uses the "Manage everything on your Page" use case and isn't attached to a business portfolio. "Require app secret" is on under App settings, Advanced, so a token is useless without `META_APP_SECRET`.

Permissions on the token: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `pages_read_user_content`, `pages_manage_engagement` and `read_insights`. Instagram permissions get added when the Instagram tools are built.

To make a Page token: in Graph API Explorer, get a user token with those permissions (tick only the SOUND7 Page, and the Shopify portfolio if asked), extend it in the Access Token Tool, then query `PAGE_ID?fields=id,name,access_token`. (`me/accounts` can come back empty because the Page is owned by a business portfolio.) The debugger should show the Page token as "Expires: Never". Never paste tokens into chat.

The app must be in Live mode for posts to be public. In development mode, API posts are visible only to people with a role on the app. Going Live needs a privacy policy, terms and data deletion URL under App settings, Basic. App Review isn't needed for posting to a Page the app owner manages.

If Facebook ever rejects the token (error 190, often after a Facebook password change), generate a new Page token the same way and replace `META_PAGE_TOKEN`.

## Changing it

```sh
npm install
npm test              # client tests against the fake Graph API
npm run test:worker   # runs the Worker locally and goes through sign-in and every tool
```

Push to `main` to deploy. To roll back, use Deployments in the Worker's dashboard page.

## Pinned versions

- `@cloudflare/workers-oauth-provider` 1.2.4
- `wrangler` 4.156.0 (dev only)
