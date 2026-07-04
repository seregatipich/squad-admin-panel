## 15. Bug Tracker & Video/Demos

Two loosely related admin-utility pages that share the SPA shell but are functionally independent:

- **Bug Tracker** — nav id `issues`, page fragment `frags/issues.html`. A GitHub-Issues-style ticket list where admins file bugs/suggestions against the SQSTAT panel itself.
- **Video / Demos** — nav id `video`, page fragment `frags/video.html`. A large-file (MP4) uploader that ships recorded evidence/demo clips out to the project's YouTube + Telegram channels.

Both are loaded the usual way (`pageLoad('issues')` / `pageLoad('video')` → `GET /ajax/page.php?page=…`), and each fragment carries its own inline `<script>` object (`var issues = {…}`, `var video = {…}`) that self-initializes on `$(document).ready`.

> Note: Neither page embeds the shared **player-detail** modal or any `script:'table'` DataTables grid. The bug tracker uses a hand-built `<ul class="list-group">` rendered client-side, and the video page is a drag-and-drop upload zone. None of the ~22 player-modal actions apply here; every action below is genuinely local to these two pages.

---

### 15.1 Bug Tracker (`issues`)

#### 15.1.1 Purpose & layout

A minimal issue tracker for the panel itself (bugs and feature suggestions). The layout is a two-column split:

- **Left rail** (`#issues_list_buttons`, `position:fixed`, 240px): action buttons — Создать (Create), Открытые (Open), Закрытые (Closed).
- **Right column** (`#issues_list`): a `list-group` of issue cards, populated by JS. Shows a spinner overlay (`.load_block`) while fetching and `Данных нет` (No data) when the list is empty.

There is **no** DataTables grid, no server-side search, and no column sorting here — filtering is purely by the two state buttons, and paging is by a `page` integer argument (see below).

#### 15.1.2 Entity: Issue

Inferred from the `issues_get` response shape consumed in `issues.list.build()` and the `issues_create` payload:

| Field | Type | Source / meaning |
|---|---|---|
| `id` | int | Ticket number, rendered as `#<id>` in a `<hashtag>` element |
| `title` | string | Issue title (shown bold). Note: **not** a create-form input — server-derived (likely first line / auto-generated), see gaps |
| `body` | string | Free-text description, max 512 chars (`textarea maxlength="512"`) |
| `state` | enum `open` \| `closed` | Lifecycle status. `open` → green "Открыто" (Open) with unlock icon; `closed` → "Закрыто" (Closed) with lock icon |
| `create` | timestamp | Creation time, run through `formatDate()` for display |
| `labels` | array of Label | Category tags (see below) |

Entity: **Label** (embedded array on each Issue)

| Field | Type | Meaning |
|---|---|---|
| `name` | string | Label text, rendered with a `fa-tag` icon |
| `color` | string | Hex color **without** `#` (JS prepends it: `background-color:#`+`l.color`) |

The create form hard-codes exactly two selectable labels:

| `value` | Label | Color |
|---|---|---|
| `1` | Баг (Bug) | `#e11d21` (red) |
| `2` | Предложение (Suggestion) | `#207de5` (blue) |

#### 15.1.3 The page's own "table" (issue list)

Rendered as cards, not a `<table>`. Each `<li class="list-group-item">` shows:

| Card element | Content |
|---|---|
| `#<id>` | Ticket number (`<hashtag>`) |
| Title | `v.title` in a `<label>` |
| State badge | `<code>` pill — green "Открыто" / grey "Закрыто" (pull-right) |
| Date | `formatDate(v.create)` `<small>`, pull-right |
| Body | Full description paragraph |
| Labels | One `<span class="label">` per label with tag icon + colored background |

Filter/sort/pagination controls:

- **State filter:** two buttons call `issues.list.get('open',1)` / `issues.list.get('closed',1)`.
- **Pagination:** `get(state, page=1)` sends a `page` param, but the fragment renders **no page navigation UI** — only page 1 is ever requested from the buttons. The backend clearly supports paging; the frontend does not yet expose it (competitive gap).
- **No search box, no per-column sort.**

#### 15.1.4 Actions / capabilities

| UI label | Trigger | action id | Script endpoint | Data params | Effect | State-changing? |
|---|---|---|---|---|---|---|
| Открытые (Open) | `issues.list.get('open',1)` | `issues_get` | `POST /ajax/squad.php` | `state=open`, `page=1` | Fetch open issues → rebuild list | N (read) |
| Закрытые (Closed) | `issues.list.get('closed',1)` | `issues_get` | `POST /ajax/squad.php` | `state=closed`, `page=1` | Fetch closed issues → rebuild list | N (read) |
| Создать (Create) — open modal | `issues.create.show()` | — | — (client only) | — | Opens `#issuesModal_create`, inits the multiselect | N |
| Создать (Create) — submit | `issues.create.create(this)` | `issues_create` | `POST /ajax/squad.php` | `body=<textarea>`, `labels=<array of value ids>` | Creates a new ticket, then reloads the open list and hides the modal | **Y** |

Notes on the endpoint contract (from the shared `Action()` helper):

- All calls go to `/ajax/squad.php`; body is `action=<id>&…` URL-encoded (objects are flattened to `&key=value`).
- Success is gated on `text.status == 'ok'`; `text.auth === true` forces a full `location.reload()` (session expiry). Errors surface via `addAlert(msg, …)`.
- On create success the client re-requests `issues_get(open,1)` — so a newly created issue is assumed to land in `open` state (no client-side status is sent).

There is **no close/reopen/edit/delete/comment action in this fragment.** Admins can only create and read issues; the `closed` state exists in data but no UI here transitions an issue to it (likely handled elsewhere or by maintainers server-side). This is a notably thin CRUD surface.

#### 15.1.5 Create modal (`#issuesModal_create`)

| Element | id | Type | Validation / notes |
|---|---|---|---|
| Описание проблемы (Problem description) | `issuesModal_create-body` | `textarea` rows=4 | `maxlength="512"`; no client-side "required" check — empty submit is possible client-side |
| Метки (Labels) | `issuesModal_create-labels` | `<select multiple>` → Bootstrap `multiselect` | `nonSelectedText:'- Метки -'`, `enableHTML:true` (option labels contain styled `<span>` HTML). Optional; sends array of value ids (`1`/`2`) |
| Создать (Create) | — | button | `btnload('Создаём')` spinner during submit; resets on success/error |

`enableHTML:true` on the multiselect is what lets each option render as a colored pill (`Баг` red / `Предложение` blue) inside the dropdown.

#### 15.1.6 Permissions / visibility

No `class="hide"`, no role/group gating in this fragment. Every element is visible to anyone who can load the `issues` page — access control is entirely upstream (whether the nav item / `page.php?page=issues` is served). Both mutating and reading actions hit `script:'squad'`, implying this page is scoped to squad/panel admins rather than the general `public` script.

---

### 15.2 Video / Demos (`video`)

#### 15.2.1 Purpose & layout

A big-file uploader for demo/evidence videos (rule-violation clips, highlights). Uploaded MP4s are fanned out by the backend pipeline: **Browser → Sqstat → YouTube + Telegram** (stated verbatim in the modal help text). Header links point at the project's Telegram (`t.me/sqstat`) and YouTube channel.

Layout:

- **Header row**: Telegram link, YouTube link, and a pull-right button **Генерировать ссылку** (Generate link) that opens the token modal.
- **Drop zone** (`#drag.drop_file_zone`, ~76vh): full-height drag-and-drop area with a cloud-upload prompt "Загрузите файлэ" and a "(2ГБ)" size hint. Contains a hidden `<input type="file" accept=".mp4">`.
- Two modals: upload metadata (`#loadModal`) and token generation (`#tokenModal`).

#### 15.2.2 Entity: Video upload

Inferred from the `uploadVideo` `FormData` payload:

| Field | Type | Source | Meaning |
|---|---|---|---|
| `name` | string | `#video-name` | Short title, e.g. placeholder «Нарушение правил Enj0y» (Rule violation, player Enj0y) |
| `description` | string | `#video-description` | Free-text description of what happens in the clip |
| `file` | binary (MP4) | drop zone `input[type=file]` | The video file itself |
| `token` | string \| null | `getURLParameter('token')` | One-time upload token pulled from the page URL query string (see token flow) |

Accepted types: the drop handler is wired for `['.mp4','.avi']` (`dragFile(['.mp4','.avi'])`) while the `<input accept=".mp4">` only advertises MP4. Effective size ceiling advertised: **2 GB**. Client upload timeout: **300 s** (`timeout: 300*1000`).

> **Linkage to matches/players is not modeled client-side.** There is no match id, server id, round id, SteamID/UUID, or player selector in the payload — only free-text `name`/`description`. Any association to a specific match or offender is human-entered prose, not a foreign key. This is a meaningful contrast to a panel that could link demos directly to a match/kill/report record.

#### 15.2.3 Entity: Upload token

| Field | Type | Meaning |
|---|---|---|
| `token` | string | One-time upload credential returned by `uploadVideo_token`, shown read-only in `#upload-token` |

Token semantics (from modal help text): the generated link is **valid for 2 hours** and **usable exactly once** («Ссылка доступна для загрузки 2 часа, загрузить можно 1 раз»). The intent is delegated uploads — an admin generates a link and hands it to someone (e.g. a player submitting evidence) who is not otherwise authenticated. On the upload page the token is read from the URL (`?token=…`) and attached to the `uploadVideo` call.

#### 15.2.4 Actions / capabilities

| UI label | Trigger | action id | Script endpoint | Data params | Effect | State-changing? |
|---|---|---|---|---|---|---|
| Генерировать ссылку → open modal | `video.token.show()` | — | — (client) | — | Opens `#tokenModal` | N |
| Создать токен (Create token) | `video.token.gen()` | `uploadVideo_token` | `POST /ajax/squad.php` | *(none)* — `data:{}` | Returns a one-time upload `token`, populated into `#upload-token` | **Y** (mints a credential) |
| Загрузить (Upload) | `video.upload()` | `uploadVideo` | `POST /ajax/public.php` | `FormData`: `name`, `description`, `file`, `token` | Uploads the MP4; backend forwards to YouTube + Telegram | **Y** |

Key endpoint split (competitively interesting):

- **Token minting uses `script:'squad'`** (authenticated admin context) — only a logged-in admin can create a token.
- **The actual upload uses `script:'public'`** — the public endpoint, authorized by the one-time `token` rather than a session. This is what enables handing an upload link to an unauthenticated third party.

Because `data` is a `FormData` instance, the `Action()` helper sets `processData=false`, `contentType=false`, and appends `action=uploadVideo` into the form — a standard multipart file POST with upload-progress instrumentation.

#### 15.2.5 Upload modal (`#loadModal`) — fields & UX

| Element | id | Type | Notes |
|---|---|---|---|
| Название видео (Video name) | `video-name` | text | Help: "Короткое название видео" (short title). Placeholder example «Нарушение правил Enj0y» |
| Описание видео (Video description) | `video-description` | textarea rows=2 | Help: "Опишите что происходит на видео" (describe what happens) |
| Загрузить (Upload) | `video-upload` | button | Hidden during upload; triggers `video.upload()` |
| Progress bar | `load_bar` | div | Live width %, big `%` label |
| Progress detail | `load_bar-upload_progress` / `load_bar-upload_speed` | spans | "`<uploaded> / <total> МБ`" and "`<speed> Мбит/c`" (Mbit/s) |

No explicit client-side validation (name/description can be blank; only extension is checked in the drop handler). During upload the modal is made non-dismissable: a `hide.bs.modal` handler calls `e.preventDefault()` so the user cannot close it mid-transfer; on error/completion the handler is detached (`.off('hide.bs.modal')`).

Progress metering comes from the shared `Action()` helper's `xhr.upload` `progress` listener, which computes MB total, MB uploaded, and Mbit/s throughput each tick and hands them to the fragment's `progress` callback.

Help text also warns that **YouTube has a daily upload quota** — videos may post "immediately or the next day" — whereas **Telegram uploads immediately**. So the two fan-out targets have different latency guarantees.

#### 15.2.6 Token modal (`#tokenModal`)

| Element | id | Type | Notes |
|---|---|---|---|
| Token field | `upload-token` | text, `readonly` | Displays the minted token/link |
| Создать токен (Create token) | `generate-token` | button | Calls `video.token.gen()`; `btnreset(600)` cooldown after |
| Help text | — | — | "Ссылка доступна для загрузки 2 часа, загрузить можно 1 раз" (valid 2h, single use) |

Minor bug worth noting: `video.token.gen` is bound in the HTML as `onclick="video.token.gen()"` (no argument), but the JS body reads `gen: function(btn){ $btn = $(btn); … }` — so `btn` is `undefined` and `$btn` becomes an empty jQuery set; the `btnload()`/`btnreset()` spinner on the button silently no-ops. The Action call itself still works.

#### 15.2.7 Drag-and-drop mechanics

`$.fn.dragFile(ext)` (custom.js) wires the drop zone: on `drop` or `click` it takes the first file, validates the extension against the allowed list, injects it into the hidden `<input type=file>` via a synthetic `DataTransfer`, and fires an `end` event carrying the file. The fragment's `init()` listens for `end` to open the metadata modal, and for `start`/`progress`/`error` (mostly console logging). Files failing the extension check are silently rejected (`return false`); a null file triggers `alert('Ошибка файла')` (File error).

#### 15.2.8 Permissions / visibility

No `class="hide"` or role checks in the fragment. The security model is endpoint-based rather than DOM-based:

- Loading the `video` page and minting a token requires the authenticated `squad` context.
- The `public` upload endpoint trusts the one-time, 2-hour, single-use `token` — this is the mechanism for delegating uploads to non-admins.

---

### 15.3 Competitively interesting takeaways

- **Two-endpoint upload auth (`squad` mint + `public` consume):** a clean pattern for letting players submit evidence without accounts — admin generates a single-use, time-boxed link; upload happens on the public endpoint. Worth copying, and easy to beat by also binding the token to a specific report/match id so submitted footage auto-links to a case.
- **No structured linkage of videos to matches/players/reports** — SQSTAT stores only free-text `name`/`description`. A competing panel that attaches demos to a match/kill/ban record (foreign keys, jump-to-timestamp) is strictly more useful.
- **Fan-out to YouTube + Telegram with quota-aware messaging** — the backend externalizes storage to free platforms (2 GB clips) and honors YouTube's daily quota. Cheap hosting, but no in-panel playback and latency is inconsistent (YouTube may lag a day).
- **Bug tracker is create/read only, no pagination UI, no status transitions** — `state=closed` and `page` exist in the API but are not fully wired in the UI. A richer tracker (assignee, comments, close/reopen, search, real pagination) is an easy differentiator.
- **512-char body cap and only two labels (Bug/Suggestion)** — deliberately lightweight; the tracker is for panel feedback, not game moderation cases.
