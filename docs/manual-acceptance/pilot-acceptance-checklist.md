# Pilot Manual Acceptance Checklist

This is the operator-driven test script for the new MarkLab pilot path
(MarkEdit-derived native shell + `/collab` browser app + Y-Sweet provider
+ control plane). It assumes a healthy deployed or local target and walks
you through ~90 minutes of structured testing that automated tests cannot
cover (real GUI behavior, real provider-token refresh, real disk projection,
real cursor rendering, real conflict UX).

Pair this with [`new-relay-pilot.md`](./new-relay-pilot.md), which covers
the setup, seeding, and `/healthz` gating.

## When To Run This

Run the full pass:

- Before inviting the first 10-50 pilot users.
- After any deploy that touches `apps/api`, `apps/collab-web`,
  `apps/marklab-macos`, `packages/collab-editor`, or `apps/api`'s schema.
- After upgrading Y-Sweet, the control-plane session protocol, or the
  MarkEdit shell.

Skip to specific phases when only one area changed (each phase is
self-contained).

## What This Does Not Cover

- Stripe / paid billing — manual/free only in alpha.
- Hosted Versions panel — README explicitly defers it.
- Hosted OIDC provider-specific behavior — covered by the Gate 6 live smoke after real `MARKLAB_OIDC_*` secrets are configured and deployed.
- Performance under load — needs a separate load-test harness.

If you find issues outside this checklist, log them anyway under the
"Out of scope but observed" section of the final report.

## Pre-flight (5 min)

Before starting the timer, you must have:

- [ ] **A healthy target.** Either `marklab-relay-alpha.fly.dev` or your
  local `127.0.0.1:3181` from `new-relay-pilot.md`. Verify:
  ```sh
  curl -fsS https://marklab-relay-alpha.fly.dev/healthz | jq .
  ```
  Required: `ok: true`, `schema.ready: true`, `provider.ready: true`,
  `provider.storeReady: true`.
- [ ] **A pilot owner session token** (`ml_user_...`) and a workspace id.
  Bootstrap via `scripts/marklab-bootstrap-alpha-user.mjs` or the
  `new-relay-pilot.md` seeding block.
- [ ] **A seeded pilot document** plus one edit grant URL and one view
  grant URL. Copy both to a scratch notepad — you will reopen them several
  times.
- [ ] **MarkLab.app built locally:**
  ```sh
  swift build --package-path apps/marklab-macos
  ```
- [ ] **A scratch directory** (e.g. `~/marklab-pilot-acceptance/`) with
  a single test Markdown file: `pilot.md`. This is the local artifact for
  app-side tests.
- [ ] **Two browsers or two profiles** ready (e.g. Chrome + Firefox, or
  Chrome regular + Chrome incognito). You need two distinct browser
  identities to test cursor/presence.
- [ ] **A terminal window** with `psql` access to the same Neon/Postgres
  for the deployment (for the revocation test).

### Recommended short-TTL testing knob

For Phase 3 (refresh behavior), waiting the full 10-minute provider
token TTL is wasteful. If you control the deployment, restart the API
once with these env overrides for the duration of acceptance:

```sh
MARKLAB_PROVIDER_TOKEN_TTL_SECONDS=120
MARKLAB_PROVIDER_TOKEN_REFRESH_MARGIN_SECONDS=60
MARKLAB_PROVIDER_TOKEN_REFRESH_CHECK_INTERVAL_SECONDS=15
```

That makes tokens expire every 2 min and refresh at 1 min, with a 15s
check loop. Revert to defaults (`600` / `120` / `30`) before inviting
pilot users.

### Open this file in the bug log

Open `bug.md` in a second editor window now, scroll to the bottom, and
prepare a new section header (you will add entries as you go):

```md
## Pilot Manual Acceptance — <YYYY-MM-DD>

Target: <https://marklab-relay-alpha.fly.dev | http://127.0.0.1:3181>
Operator: <your name>
Git SHA under test: <git rev-parse HEAD>

### Findings
```

If the pass produces zero findings, replace `### Findings` with
`No findings — pass clean.` and you are done.

---

## Phase 1 — Smoke (10 min)

The fastest tests. If any one of these fails, stop here and fix it
before continuing. The rest of the matrix depends on a working baseline.

### 1.1 Browser edit link mounts an editor (2 min)

1. Open the **edit grant URL** in browser A.
2. **Expect:**
   - Page loads without console error.
   - A CodeMirror source editor appears with the seeded content.
   - No `Unavailable`, no `invalid_edit_session_*`, no error banner.
3. **Type a character.** It should appear immediately.
4. **Open browser devtools → Network.** Verify a websocket to
   `/d/<providerDocId>/ws/<providerDocId>` is established (status 101).
5. **Open Application → IndexedDB.** Verify a `y-indexeddb` database
   for the provider doc id exists.

**Pass:** all five expectations hold.
**Fail:** log under Phase 1.1.

### 1.2 View link mounts a read-only render, no provider connection (2 min)

1. Open the **view grant URL** in browser A (new tab).
2. **Expect:**
   - Rendered Markdown appears (headings styled, paragraphs flow, no raw `#`).
   - No CodeMirror editor surface; you cannot place a caret.
   - **No websocket** to `/d/...` in Network panel. Spec: view links do
     not receive provider credentials.
   - No IndexedDB entry for the provider doc.
3. **Try typing** — nothing happens. Try keyboard arrow keys — no caret.

**Pass:** rendered view only, no provider traffic.
**Fail:** if a websocket opens, that's a critical permission leak — log it.

### 1.3 Native app launches the MarkEdit shell (2 min)

1. Launch:
   ```sh
   set -a; source ./.env.marklab-pilot; set +a
   swift run --package-path apps/marklab-macos MarkLabApp
   ```
2. **Expect:**
   - A document window appears at roughly 720×480.
   - The toolbar shows MarkEdit-style controls in this order:
     Table of contents → Heading → Bold/Italic → List → Collaboration menu.
   - File → Open works (Cmd+O); open `~/marklab-pilot-acceptance/pilot.md`.
   - Line 1 of the file is visible (not hidden under the toolbar).
3. **Type a character.** It should appear at the caret.

**Pass:** window opens, file loads, toolbar matches MarkEdit cluster.
**Fail:** if it loads a SwiftUI `TextEditor` instead of the WebKit/CodeMirror
shell, that's a Plan 5.5 regression — log it.

### 1.4 Native Save preserves bytes (2 min)

1. In the app, type `acceptance test\n` at the end of the document.
2. Cmd+S to save.
3. In a terminal: `cat ~/marklab-pilot-acceptance/pilot.md`.
4. **Expect:** file ends with `acceptance test\n` (LF, not CRLF).

**Pass:** disk content matches editor exactly.

### 1.5 Health check still green after smoke (1 min)

```sh
curl -fsS <BASE>/healthz | jq .
```

Should still be `ok: true`. If any field has flipped to false during
testing, log it — that suggests state corruption.

---

## Phase 2 — Convergence & presence (25 min)

This is the heart of the collaboration product. Where most bugs live.

### 2.1 Browser ↔ Browser convergence (5 min)

1. Open the **edit link in browser A and browser B**. Browser B should
   be a different profile/incognito (different identity).
2. In browser A, type `from A\n`. Verify it appears in browser B within
   ~1 second.
3. In browser B, type `from B\n`. Verify it appears in browser A.
4. In browser A, place caret between two existing lines and type.
   In browser B, simultaneously type elsewhere. Both must converge —
   neither client's text should disappear or duplicate.

**Pass:** both tabs always show the same text.
**Fail signatures:** content diverges, duplicates a line, drops a line,
or one tab is "stuck" at older content.

### 2.2 App ↔ Browser convergence (5 min)

1. In MarkLab.app, click **Start Sharing** → **Create Edit Link**.
   The link is copied to clipboard.
2. Open the clipboard link in browser B (close the browser-A edit tab
   first to avoid stale presence in this test).
3. Type `from app\n` in MarkLab.app. Verify it appears in the browser
   within ~1 second.
4. Type `from browser\n` in the browser. Verify it appears in
   MarkLab.app within the ~2-second debounce window.
5. `cat ~/marklab-pilot-acceptance/pilot.md` — disk should contain
   both lines after the projection debounce flushes.

**Pass:** both surfaces converge and disk reflects both edits.

### 2.3 Cursor and selection three-way (5 min)

1. Keep MarkLab.app + browser B from 2.2 open. Open browser A on the
   same edit link.
2. **App→browser:** click in MarkLab.app, position caret on line 2.
   Browser A and browser B should both show a colored caret labeled
   with the app's display name. The color should be stable.
3. **Browser→app:** click in browser A, select a phrase. MarkLab.app
   should show a colored highlight covering that range, plus a caret
   at the selection edge.
4. **Browser→browser:** select text in browser A; browser B should show
   the highlight.
5. Type in browser A while browser B's caret is positioned ahead of
   the insertion point. Browser B's caret must stay anchored to its
   text, not jump to the insertion point.

**Pass:** all three directions render cursors and selections; colors
are stable; selection anchors survive concurrent insertion.
**Fail signatures:** caret jumps, color flickers, no remote caret
appears, multi-line selection renders as a single line.

### 2.4 Cursor disappears on disconnect (3 min)

1. With both browser tabs open and showing each other's carets,
   close browser B's tab.
2. **Expect:** browser A's display of browser B's caret/label
   disappears within ~5 seconds.
3. Reopen the edit link in browser B (fresh tab).
4. **Expect:** caret reappears with the same color/identity if the
   `PermanentUserData` mapping persisted, or with a fresh identity
   if it didn't (both are acceptable for v1; the spec only requires
   stability within a session).

**Pass:** stale caret removed on disconnect.

### 2.5 Awareness identity is sanitized (2 min)

If you have control of an edit-capable session's display name:

1. Set a display name like `<script>alert(1)</script>`.
2. Verify in the other browser that the name renders as text, not as
   an injected script tag.

**Pass:** no JS execution; literal characters visible.
**Skip if:** you can't easily set a malicious display name in your
seeding script. Note it as a follow-up.

### 2.6 Disk projection debounce (5 min)

1. In MarkLab.app, type rapidly for ~5 seconds.
2. **Observe:** the file on disk should NOT update on every keystroke.
   Spec says ~2-second debounce.
3. Stop typing. Within ~3 seconds, disk should reflect the latest text.
4. Trigger Cmd+S during typing. Disk should flush immediately
   (no waiting for debounce).
5. Now externally edit the file:
   ```sh
   echo "external edit at $(date)" >> ~/marklab-pilot-acceptance/pilot.md
   ```
6. **Expect:** within a few seconds, MarkLab.app and the browser tab
   both show the appended line. (This is the file-watcher ingestion
   path.)

**Pass:** debounce visible, Cmd+S flushes, external edits ingested.

---

## Phase 3 — Permissions & lifecycle (25 min)

### 3.1 Edit link refresh is transparent (5 min, or 12 min on default TTL)

**Prerequisite:** for fast testing, set the short-TTL env knobs from
pre-flight. Otherwise budget 12 minutes.

1. Open a fresh edit-link browser tab. Note the time.
2. Open devtools → Application → IndexedDB and watch for a refresh
   event, OR open Network and filter for `collab/session/refresh`.
3. Wait until the refresh interval triggers (defaults: 1 min on short
   TTL, ~8 min on production TTL).
4. **Expect:** a `POST /api/.../collab/session/refresh` returning 200
   with a fresh provider token. Editor stays connected. No flicker.
   No "Reconnecting" banner for more than a half-second.
5. Type during and after the refresh window. Edits commit normally.

**Pass:** refresh is invisible to the user.
**Fail signatures:** "Reconnecting" persists, editor flips to
`Unavailable`, edits made during the window are lost.

### 3.2 Revoked edit link goes unavailable within TTL (5 min)

1. With a browser tab open on the edit link, in your seeding terminal:
   ```sh
   psql "$DATABASE_URL" -c \
     "update document_access_grants set revoked_at = now() where token_hash = (select token_hash from document_access_grants order by created_at desc limit 1);"
   ```
   (Or use the native UI's revoke action.)
2. Continue typing in the browser. Edits should still apply locally
   until the next refresh.
3. Wait for the next refresh attempt (1 min on short TTL).
4. **Expect:**
   - Editor transitions to "Unavailable" (or equivalent unavailable
     banner).
   - Editor becomes read-only — typing does not modify content.
   - Network shows a 4xx response on the refresh attempt with
     `grant_revoked` or similar.

**Pass:** within TTL, the editor is conclusively read-only and shows
unavailable state.
**Fail signatures:** editor stays writable indefinitely, or shows only
"Reconnecting" forever.

### 3.3 Revoked view link fails on next fetch (2 min)

1. Open the view link in browser B. Verify it renders.
2. Revoke the view grant (same SQL pattern, different grant).
3. Reload the page.
4. **Expect:** the page shows an unavailable/forbidden state, not the
   document.

**Pass:** view link revocation takes effect on next fetch.

### 3.4 Role downgrade ≠ merge conflict (3 min)

This is a subtle but important distinction (closed bug Plan 5.x).

1. Issue another edit grant. Open it in browser A.
2. Change the grant role to `view` in the database:
   ```sh
   psql "$DATABASE_URL" -c \
     "update document_access_grants set role = 'view' where id = '<grant id>';"
   ```
3. Wait for the next refresh.
4. **Expect:** Editor goes to Unavailable. There must NOT be a merge
   conflict shown — this is a permission denial, not a content conflict.

**Pass:** unavailable state, no conflict UI.
**Fail:** if a conflict dialog opens, that's a real bug — log it.

### 3.5 Guest quota blocks new session but not existing one (5 min)

Skip if your seeded workspace has unlimited guest seats. Otherwise:

1. Open 2-3 edit links until guest quota is reached.
2. Try to open one more in a fresh browser. The session-create
   request should return a quota error.
3. The already-open sessions must continue editing normally.

**Pass:** new session blocked, existing sessions unaffected.

### 3.6 Native bearer cannot be spoofed by URL (5 min)

This proves the closed bug #82/#88 fix.

1. Take the **public edit link** URL from a browser session.
2. Append `&clientKind=app` to the URL manually.
3. Open it in a regular browser.
4. **Expect:** the control-plane response carries
   `session.clientKind: "browser"` (server downgrades), and the editor
   does NOT mount as if it were a native app session.

Verify in devtools by inspecting the session response JSON.

**Pass:** server forces `browser` clientKind for non-bearer requests.

---

## Phase 4 — Edge cases (20 min)

### 4.1 Guest editing while host app is offline (3 min)

1. Re-open MarkLab.app + browser on the same edit grant.
2. Quit MarkLab.app.
3. In the browser, continue typing for ~30 seconds.
4. **Expect:** edits commit normally. Provider sync continues.
5. Reopen MarkLab.app with the same file.
6. **Expect:** the editor receives the missed edits within a few
   seconds of reconnect. Disk file updates with the combined content.

**Pass:** host downtime doesn't block guests; host catches up on return.

### 4.2 Browser offline → reconnect (3 min)

1. With a browser tab on the edit link, open devtools → Network →
   set to Offline.
2. Type ~5 lines of text. Status should transition to
   "Reconnecting" / offline.
3. Verify edits are stored in IndexedDB (visible in Application panel).
4. Set Network back to Online.
5. **Expect:** within a few seconds, status returns to Connected,
   and the previously-offline edits become visible in other tabs.

**Pass:** offline edits queue locally and flush on reconnect.
**Fail signatures:** offline edits are lost, status stays
"Reconnecting" forever, duplicate text appears after reconnect.

### 4.3 Missing local file pauses projection (3 min)

1. With MarkLab.app sharing `pilot.md`, in a terminal:
   ```sh
   mv ~/marklab-pilot-acceptance/pilot.md ~/marklab-pilot-acceptance/pilot.md.bak
   ```
2. **Expect:** app shows a paused / missing-file state. It does NOT
   silently recreate the file.
3. Continue editing in browser. The provider state may advance, but
   MarkLab.app's projection should pause.
4. Restore the file:
   ```sh
   mv ~/marklab-pilot-acceptance/pilot.md.bak ~/marklab-pilot-acceptance/pilot.md
   ```
5. **Expect:** projection resumes; provider state and disk reconcile.

**Pass:** explicit paused state when file goes missing; clean recovery.

### 4.4 Disk + provider both diverge → conflict UI (5 min)

The most important edge case. This is the main reason conflict UI exists.

1. Open MarkLab.app + browser on the same edit link. Verify they're
   in sync.
2. Quit MarkLab.app.
3. In browser, type `BROWSER CHANGE\n`.
4. In terminal: `echo "DISK CHANGE" >> ~/marklab-pilot-acceptance/pilot.md`.
5. Now relaunch MarkLab.app.
6. **Expect:**
   - Native conflict panel opens.
   - Shows local (disk) version with `DISK CHANGE`.
   - Shows shared (provider) version with `BROWSER CHANGE`.
   - Shows an explicit diff between them.
   - The editor surface is read-only while conflict is open.
   - Three actions visible: **Accept Local**, **Keep Shared**,
     **Paste Resolved** (with `APPLY RESOLVED` confirmation).
7. Click **Accept Local**.
8. **Expect:** provider state replaced with disk content; disk
   unchanged; browser receives the disk version; conflict UI closes;
   editor becomes writable again.

**Pass:** conflict opens, diff renders, resolution applies cleanly.
**Fail signatures:** silent overwrite of either side, missing actions,
empty diff pane.

### 4.5 Paste-resolved confirmation guard (2 min)

This proves closed bug #100/#101.

1. Trigger another conflict (same recipe as 4.4).
2. Click **Paste Resolved** with an empty buffer.
3. **Expect:** apply button is disabled until non-empty content
   is pasted AND the confirmation string `APPLY RESOLVED` is typed.

**Pass:** double-confirm required.
**Fail:** if a single click can publish an empty document, that's a
data-loss bug — log critical.

### 4.6 External atomic save during conflict (4 min)

This proves closed bug #95/#96/#103.

1. Trigger a conflict (4.4).
2. While the conflict is open, externally atomically replace the file:
   ```sh
   cat > /tmp/new-content.md <<'EOF'
   external atomic replacement
   EOF
   mv /tmp/new-content.md ~/marklab-pilot-acceptance/pilot.md
   ```
3. Click **Keep Shared** (or **Accept Local**) — pick either.
4. **Expect:** resolution either succeeds without overwriting the
   external content, OR it refreshes the conflict to show the new
   external content. It must NOT silently overwrite the external file.

**Pass:** external content preserved or conflict re-opens.
**Fail:** external content overwritten.

### 4.7 Agent local edit/replace smoke (5 min)

This covers the v1 agent contract: agents edit the local Markdown file,
and MarkLab.app ingests that disk change into the shared provider state.
It does not require a real model run; terminal writes exercise the same
file-watcher path.

1. With MarkLab.app and one browser edit tab open on the same shared
   local file, confirm there is no conflict panel open.
2. Simulate an agent append:
   ```sh
   printf '\nAGENT LOCAL EDIT phase47\n' >> ~/marklab-pilot-acceptance/pilot.md
   ```
3. **Expect:** within a few seconds, MarkLab.app and the browser edit
   tab both show `AGENT LOCAL EDIT phase47`.
4. Simulate an agent full-file atomic replace while preserving current
   content:
   ```sh
   cp ~/marklab-pilot-acceptance/pilot.md /tmp/marklab-phase47-agent.md
   printf '\nAGENT ATOMIC REPLACE phase47\n' >> /tmp/marklab-phase47-agent.md
   mv /tmp/marklab-phase47-agent.md ~/marklab-pilot-acceptance/pilot.md
   ```
5. **Expect:** MarkLab.app and the browser edit tab both show
   `AGENT ATOMIC REPLACE phase47`, or a conflict opens if a provider
   edit raced the disk replacement. It must not silently overwrite the
   agent replacement.

**Pass:** append and atomic-replace disk changes are ingested into app
and browser, or an explicit conflict opens for a real race.
**Fail:** agent-written content disappears silently, does not reach the
browser/app, or is overwritten without a conflict.

### 4.8 Agent atomic replace during active user typing (5 min)

This is the high-risk race: a user is actively editing in the shared
editor while an agent performs a full-file local replacement from disk.

1. With MarkLab.app and one browser edit tab open on the same shared
   local file, confirm there is no conflict panel open.
2. In the browser or app editor, type a unique marker and keep the
   cursor active:
   ```text
   USER ACTIVE TYPING phase48
   ```
3. Before waiting for everything to settle, simulate an agent direct
   full-file replacement that intentionally does not include the user
   marker:
   ```sh
   cat > /tmp/marklab-phase48-agent.md <<'EOF'
   AGENT DIRECT REPLACE phase48
   EOF
   mv /tmp/marklab-phase48-agent.md ~/marklab-pilot-acceptance/pilot.md
   ```
4. **Expect:** one of these acceptable outcomes:
   - An explicit conflict opens and shows the user/provider text versus
     the agent disk replacement.
   - The agent replacement becomes the shared document only if it is
     clearly ingested as the latest local file state; browser/app both
     converge to `AGENT DIRECT REPLACE phase48`.
5. Continue typing another short marker after the replace:
   ```text
   USER AFTER REPLACE phase48
   ```
6. **Expect:** the post-replace typing is either preserved in the
   current shared document or blocked by a visible conflict/read-only
   state. It must not disappear silently.

**Pass:** no silent rollback, no hidden overwrite, and any real race is
represented as an explicit conflict or a clearly converged replacement.
**Fail:** user typing or agent replacement disappears silently; app and
browser disagree for more than a few seconds without a conflict/status.

---

## Phase 5 — Native shell polish (5 min)

Quick visual checks of the MarkEdit-derived shell. These are subjective
but documented in closed bugs #1-#31 of the 5.5 section.

### 5.1 Window metrics

- [ ] Initial window is ~720×480.
- [ ] After resize, close, and reopen, the user's resized frame is
      restored (autosaved frame, closed bug 5.5 #11).

### 5.2 Toolbar layout

- [ ] Order matches MarkEdit: Table of contents → Heading → B/I →
      List → Collaboration menu.
- [ ] Heading menu shows levels 1-6 (closed bug 5.5 #14).
- [ ] Bold/Italic toggle, do not nest, when applied to already-marked
      text (closed bug 5.5 #13, #19).
- [ ] List commands preserve indentation on toggle (closed bug 5.5 #22).

### 5.3 Operational status

- [ ] Bottom-right shows line/column status pill (MarkEdit-style).
- [ ] Open or save errors surface as a second floating status pill,
      not as a permanent banner (closed bug 5.5 #10).

### 5.4 Shared mode visual parity

- [ ] When sharing is active, the hosted `/collab` editor appears
      inside the MarkEdit shell (toolbar + status visible), NOT as
      a separate web-app frame (closed bug 5.5 #18, #23).
- [ ] Remote cursors render in the shared editor (this is the visible
      proof of closed bug 5.5 #23).

---

## Bug entry template

For every failure or oddity, append an entry to `bug.md` under your
session header. Use this exact shape so the engineer can act without
asking follow-ups:

```md
N. **Short title.** (Phase X.Y)
   - Repro:
     1. <exact step>
     2. <exact step>
     3. <exact step>
   - Observed: <what happened, including any UI text, console errors, network status codes>
   - Expected: <what the spec or this checklist says should happen>
   - Severity: critical | high | medium | low
   - Environment: <target URL, git SHA, browser+version OR app launch command>
   - Evidence: <screenshot path, log snippet, har file path>
   - Notes: <any guesses on root cause, related closed bugs in bug.md>
```

Severity guide:

- **Critical:** data loss, security leak (view link writes, cross-tenant
  read), or "cannot proceed with pilot" blockers.
- **High:** user-visible flow is broken but data is safe (e.g. conflict
  resolution silently no-ops; refresh never completes).
- **Medium:** annoying UX (caret jumps, status flicker) but workflow
  succeeds.
- **Low:** cosmetic, edge case unlikely to hit pilot users.

## Final report template

At the end of the pass, append this summary to `bug.md`:

```md
### Pilot acceptance summary — <YYYY-MM-DD>

- Pre-flight: PASS | FAIL (<reason>)
- Phase 1 (smoke): PASS | FAIL — <X / 5 checks>
- Phase 2 (convergence + presence): PASS | FAIL — <X / 6 checks>
- Phase 3 (permissions + lifecycle): PASS | FAIL — <X / 6 checks>
- Phase 4 (edge cases): PASS | FAIL — <X / 6 checks>
- Phase 5 (native polish): PASS | FAIL — <X / 4 checks>

Findings logged: <total count>
  Critical: <n>
  High: <n>
  Medium: <n>
  Low: <n>

Ready for invited pilot at 10-50 users: YES | NO | YES WITH KNOWN GAPS
Recommended next action: <one sentence>
```

## Escape hatches

If you get stuck early:

- **Phase 1 fails at 1.1:** the deploy is broken. Stop, fix deploy
  (typically schema or provider env). Do not waste time on later phases.
- **Phase 1 fails at 1.3 (native app):** browser tests can still proceed.
  Note as a blocker for native pilot, continue browser-only.
- **Refresh tests (3.1) blocked by long TTL:** if you cannot restart
  the API with short TTL, skip 3.1 and 3.2, mark as "DEFERRED — long
  TTL", and continue. Run them later with the env knob.
- **Conflict tests (4.4+) blocked by missing UI surface:** if conflict
  panel does not appear, that's itself a critical finding. Log it,
  skip 4.5 and 4.6, continue.
- **You are running long:** drop Phase 5 (native polish). It's the
  least likely to surface critical issues.

The point of this pass is *signal*, not completion. A 60-minute pass
that finds the three most important bugs beats a 90-minute pass that
clears all 27 checkboxes while missing them.

---

## Appendix A — Running this with a remote collaborator

Running this checklist with a friend on a different machine and network
gives you signal a same-machine test cannot: real WebSocket latency,
different macOS versions, different browsers, real input methods. This
appendix describes how to split the work without invalidating the
checklist.

### Three roles

- **Operator (you):** own the deployment, the Neon shell, and the
  seeding scripts. Drive all destructive tests (revoke grant, role
  downgrade, missing file).
- **Collaborator (your friend):** download MarkLab.app, sign in
  somehow, and join links you provide. Drive native-app tests.
- **Both:** test convergence, cursor, presence together over video.

### Login path for your friend

Three options. Recommended is a mix of A and B after the Gate 6 OIDC build is deployed with real provider secrets.

| Option | What the operator does | What the friend does | When |
| --- | --- | --- | --- |
| **A — Hosted OIDC owner** | Send the packaged MarkLab.app and confirm the deployed target has `MARKLAB_OIDC_*` configured. If testing a non-default staging target, also send the target base URLs. | Launch MarkLab.app, open Settings -> Account -> Sign In, complete hosted OIDC in the browser, and allow the `marklab://auth/callback` handoff. | Native app tests and authenticated owner tests. |
| **B — Share link only** | Create the edit grant. Send the `/collab?...` URL. | Open the URL in a browser. No login required. | Browser collaboration tests for guest edit/view links. |
| **C — Operator-seeded fallback** | Run `scripts/marklab-bootstrap-alpha-user.mjs` for the friend's email. Send the `ml_user_...` token plus workspace id over a secure channel. | Use only the incident/smoke fallback launch path the operator specifies. | Fallback only if hosted OIDC is down or not yet deployed. |

For a pre-pilot acceptance pass with one friend, use A for native app
tests and B for browser-only guest tests. Both signals matter.

### What to send your friend before the test

1. **A packaged MarkLab.app, not source.** Build once:
   ```sh
   swift build -c release --package-path apps/marklab-macos
   ```
   then zip the resulting binary, or run the packaging script if it
   produces a `.app` bundle. Do not ask them to install pnpm, swiftc,
   and clone the repo. That's developer onboarding, not pilot testing.

2. **Target configuration, only if not using the default hosted alpha.**
   MarkLab.app defaults to `https://marklab-relay-alpha.fly.dev`; for a
   staging target, send a tiny env file with the staging URLs:
   ```sh
   MARKLAB_CONTROL_PLANE_API_URL=https://marklab-relay-alpha.fly.dev
   MARKLAB_PUBLIC_WEB_URL=https://marklab-relay-alpha.fly.dev
   ```
   They run: `set -a; source ./.env.marklab-pilot; set +a; open -a MarkLab.app`.
   Do not send a user token for the normal OIDC path.

3. **One pre-created edit grant URL and one view grant URL** for the
   browser-side tests. They confirm both URLs load before you start.

4. **A real Markdown file**, not a sterile `pilot.md`. Send something
   with links, code blocks, lists, and at least some non-ASCII (CJK,
   emoji). The renderer hardening tests in `bug.md` (#39, #42, #50,
   #51) exist for a reason; real content exercises them.

### Which checklist rows split across people

The rows don't change — just who does them.

| Phase / row | Driver | Notes |
| --- | --- | --- |
| 1.1 Browser edit mounts | Both in parallel | Compare console + network independently. |
| 1.2 View link no-write | Either (once) | — |
| 1.3, 1.4 Native app | **Friend** | Your most valuable signal — clean-machine app behavior. Have them screenshot the window and toolbar so you can compare to a MarkEdit reference visually. |
| 1.5 Health check | Operator | — |
| 2.1 Browser↔browser | Friend's browser + your browser | Real two-network test. |
| 2.2 App↔browser | Friend on app, you on browser | — |
| 2.3 Cursor 3-way | Both watching both screens | Critical to see each other's caret colors and names. Do this over video screenshare. |
| 2.4 Cursor disappears | Either | — |
| 2.5 Awareness identity | Operator | Easier from the seeding script. |
| 2.6 Disk projection | Friend | They own the local file. |
| 3.1, 3.2, 3.3, 3.4 Lifecycle | **Operator only** | Friend doesn't have psql access to Neon. Friend observes the *effect* (their editor goes Unavailable); operator triggers the *cause* (revoke SQL). |
| 3.5 Quota | Operator | — |
| 3.6 ClientKind spoofing | Operator | Browser devtools work. |
| 4.1 Host offline | Friend quits app, operator watches browser | — |
| 4.2 Browser offline | Either, using devtools throttling | — |
| 4.3 Missing file | Friend deletes their local file | Operator watches the projection-pause state through a shared session. |
| 4.4-4.6 Conflict | Coordinated | Friend quits app, you both edit (you in browser, friend's disk via screenshare). Friend relaunches and drives the conflict UI. Most coordination-heavy phase. |
| 5.x Native polish | Friend | They have the clean-machine app build. Screenshots back to you. |

### Operational extras for remote testing

Add two fields to every `bug.md` entry during this pass:

```md
- Network: <your network → friend's network, e.g. "home wifi → 4G">
- Latency: <ping or roundtrip estimate, e.g. "~80ms">
- Time observed: <UTC timestamp>
```

The timestamp matters because the operator can grep Fly logs around
that moment for correlated errors:

```sh
fly logs -a marklab-relay-alpha
```

Keep that running in a terminal during the joint session. Any
unexplained UI behavior on the friend's side that lines up with a
log stack trace becomes a Medium-or-higher finding even if the user
flow recovered.

### Suggested two-person schedule

| Block | Duration | Mode | Tasks |
| --- | --- | --- | --- |
| Day before | ~30 min | Async | Operator packages the app, prepares env file and URLs, sends to friend. Friend confirms they can launch the app and see the document window. Fix any blockers before the joint session. |
| Joint session 1 | 40 min | Video on | Pre-flight (5 min) + Phase 1 (10 min) + Phase 2 (25 min). Highest-value 40 minutes. |
| Solo or async | ~25 min | Operator alone with friend on standby | Phase 3. Operator runs DB ops; friend confirms "yes my editor went Unavailable" via a short ping. |
| Joint session 2 | 20 min | Video on | Phase 4. Conflict tests are coordination-heavy and the most likely to expose real bugs. |
| Async | 5 min | Friend | Phase 5 screenshots; send to operator. |

Total real testing: ~95 minutes, plus day-before setup.

### What remains out of scope after Gate 6 repo wiring

Mark these as deferred in the final report — they're not failures of
this pass, just out of scope until the real hosted provider and later
account-management gates are complete:

- Self-serve sign-up (friend creates their own account from a marketing
  page).
- Password reset / account recovery from the product UI.
- Multi-provider sign-in (Google, GitHub, etc.).
- Hosted provider edge cases not covered by the local mock OIDC smoke.
- Workspace invite flow beyond the current owner settings/share-key path.

If any of these surface a real problem during testing (e.g. friend
cannot find a sign-in URL at all), that is itself a finding — log it
as severity High under "Out of scope but observed."
