# Flowforge

Jira OAuth 2.0 (3LO) and a read-only Jira ticket source for the Mobilewright generator. The existing Site is served by a Worker ESM backend; the frontend is embedded into its build artifact.

## Development

Requires Node 22 or newer. No dependencies need installing.

```sh
npm run build
npm test
npm run dev
```

Local preview is at `http://127.0.0.1:4173`. Without local OAuth credentials, pasted criteria and parsing still work. To test local OAuth, configure a separate localhost callback in the Atlassian app and provide the `.env.example` keys in an untracked `.env`. Local preview deliberately uses its localhost origin.

## Production configuration

Set `APP_ORIGIN`, `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET`, and a random `SESSION_SECRET` of at least 32 characters using Sites runtime environment variables. Deploy a saved version to apply an environment revision. Never put credentials in HTML, Git, the hosting manifest, or browser storage.

The registered Atlassian callback must exactly match:

`https://flowforge-mobilewright.chawapon-rr.chatgpt.site/api/auth/jira/callback`

The app requests `read:jira-work`, `read:jira-user`, `read:me`, `read:account`, and `offline_access`. The latter enables rotating refresh tokens and does not grant Jira writes. All Jira resource requests use GET against the Atlassian gateway and validate the authorized cloud site. OAuth exchanges use POST only to the Atlassian token endpoint.

Access and refresh tokens are encrypted using a server-only AES-GCM key, bound to the configured origin and session, and carried in separate HttpOnly, Secure, SameSite=Lax cookies. A separate login binding is established only on the OAuth callback and cleared on Disconnect, so a delayed refresh response cannot restore a disconnected browser session. Existing sessions created before this binding was introduced must log in again. Sessions have a maximum login-binding lifetime of 30 days. Tokens are never returned to browser JavaScript. Rotating `SESSION_SECRET` invalidates existing sessions. Disconnect clears this browser's session; it does not revoke the Atlassian app grant or invalidate a previously copied complete cookie set on the server. The Site's existing audience is preserved, with Jira data isolated by the visitor's own OAuth session.

## Ticket and generation behavior

Load a Jira key, browse URL, or board URL with `selectedIssue`. The user selects a workspace for bare keys. The server reads original description, named acceptance-criteria custom fields, and every comment page, then returns text with source identifiers. ADF table boundaries and multiline cells are preserved. A failed load clears stale results rather than silently falling back to demo fixtures.

Existing GWT scenarios are parsed individually from AC, description, and comments. Plain AC becomes explicitly unconfirmed drafts that the user can edit. There is no AI-model integration in this version: drafts are rule-based and do not claim to infer missing Given/When steps.

Script generation uses APIs inspected in `trueid-app-v3-e2e`: `core/fixtures/screenplays.ts`, `common/component/BottomNavigation.ts`, `RootTab.ts`, and `OpenMainScreenPlayImpl.ts`. Every case is exported. Exact navigation scenarios with mapped guest/basic-login preconditions and matching tab assertions have no incomplete guard. Other cases include a visible per-case warning with what is missing and what to add, matching inline TODOs, and an `INCOMPLETE SCRIPT` error guard to remove after completion. They are not automatically skipped or allowed to pass with missing checks. Scroll-to-top is not asserted by swiping the page back up. Device execution still requires the actual E2E repository and its test environment.

## Copy GWT to Jira

The GWT area has Copy Jira format for all cases and for each individual case. Clipboard output includes an HTML table for rich-text editors and Jira wiki table markup as plain text. Line breaks and literal table/HTML characters are preserved, and unconfirmed cases retain a DRAFT label. When rich clipboard access is unavailable it falls back to text; when clipboard access is denied entirely, a read-only field provides the markup for manual copying. This does not write to Jira automatically.

## Jira media and files

The ticket response includes every attachment plus media references discovered in description, ADF custom fields and comments. Media groups/single/inline nodes, wiki attachment references, link marks and embedded cards retain their source. Media Services UUIDs are matched to attachment IDs through server-side redirect metadata when filenames or attachment IDs do not identify a file uniquely. Unresolved references remain visible with an explicit warning and an original Jira link.

Raster images have lazy previews; videos and audio use native browser players with byte-range streaming for playback seeking. PDF files can open in the browser viewer. Office documents, archives, SVG, HTML and all other binary types remain available as downloads. A codec or format unsupported by the browser is reported with download/Jira alternatives. External media is linked rather than automatically fetched or embedded.

`GET /api/jira/attachment` accepts only a ticket key, authorized cloud ID and numeric attachment ID. It verifies access and membership in the issue attachment list before streaming from the Jira API. OAuth tokens and signed Media Services URLs are not sent to client code. Responses are private/no-store, support single byte ranges, and force active document formats to download with a sandbox policy. The existing read-only scopes are sufficient; no Jira write permission is used.

This feature presents and downloads media. It does not perform OCR, vision inference, transcription, or automatically convert media content into GWT.

## MCP

Two MCP surfaces:

1. **Cloud** (`/api/mcp`) — Jira OAuth, load ticket, parse GWT, draft Mobilewright script, `get_sim_scan_setup`. Docs: `/mcp` (`web/mcp-docs.html`).
2. **Local Simulator** — a11y scan / path explore on your Mac. Not runnable in the cloud worker. Setup: [`local-sim/README.md`](local-sim/README.md) or call cloud tool `get_sim_scan_setup`.

## Publishing

Build with `node scripts/build.mjs`; use the Sites source workflow to commit and push the exact source and package `dist/server/index.js` plus `dist/.openai/hosting.json`. Preserve the existing `project_id` and audience. Production credentials are managed separately from Git.
