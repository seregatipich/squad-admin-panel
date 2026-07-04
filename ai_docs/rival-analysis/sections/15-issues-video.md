## 15. Bug Tracker & Video/Demos

Two loosely related admin-utility pages that share the SPA shell but are functionally independent:

- **Bug Tracker** — nav id `issues`, page fragment served by `GET /ajax/page.php?page=issues`. A GitHub-Issues-style ticket list where admins file bugs/suggestions against the SQSTAT panel itself.
- **Video / Demos** — nav id `video`, page fragment served by `GET /ajax/page.php?page=video`. A large-file (MP4/AVI) uploader that fans recorded evidence/demo clips out to the project's YouTube + Telegram channels.

Both fragments carry an inline `<script>` object (`var issues = {…}` / `var video = {…}`) that self-initializes on `$(document).ready`. `issues.init()` immediately fires `issues.list.get('open',1)`; `video.init()` only wires the drag-drop zone (no auto-load read).

> **Capture provenance.** Live contracts captured by an authenticated headless browser rendering each page and firing its auto-load reads only. Files: `caps/issues-video/issues.network.json`, `caps/issues-video/video.network.json`, `caps/issues-video/issues.content.html`, `caps/issues-video/video.content.html`. Mutating requests were intercepted and aborted — `_blocked.json` is empty (0 blocked). Auto-load reads captured: `issues_get` (fired on page init). All other actions (`issues_create`, `uploadVideo_token`, `uploadVideo`) are user-gesture-triggered and therefore **reconstructed from `custom.js` + fragment JS, not observed on the wire** — flagged as such below.

> **Note.** Neither page embeds the shared player-detail modal nor any `script:'table'` DataTables grid. The bug tracker renders a hand-built `<ul class="list-group">` client-side; the video page is a drag-and-drop upload zone. None of the ~22 player-modal actions apply here; every action below is local to these two pages.

---

### 15.0 Live API Contracts

All four actions route through the shared `Action()` helper (`custom.js:284`). Transport rules that define every contract below:

- **URL** = `/ajax/<script>.php` where `<script>` is the `script:` key (`squad` for admin-scoped, `public` for the token-authorized upload). Method is always `POST`.
- **Body encoding.** If `data` is a plain object, the helper sets `data.action = <action>` then flattens to a URL-encoded query via `$.map(data, (v,i) => '&'+i+'='+v).join('')`. This yields a body **with a leading `&`** and **arrays stringified by `Array.toString()` (comma-joined)**. If `data` is a `FormData`, it appends `action` to the form and sets `processData=false`, `contentType=false` (multipart).
- **Response envelope** (JSON, `Content-Type: application/json; charset=utf-8`). The helper branches on `text.status`:
  - `status == 'ok'` → `success(text)` fires.
  - `status != 'ok'` **and** `text.auth === true` → hard `location.reload()` (session expired).
  - otherwise → `error(text.msg, null)` → `addAlert(text.msg, …)`.
- Every successful JSON payload observed also carries `exec_time: float` (server wall-clock seconds). `issues_get` additionally returns a `test: { getAdmin: float }` micro-benchmark block.

#### 15.0.1 `issues_get` — list issues (CAPTURED)

Contract source: `caps/issues-video/issues.network.json[1]` (live, status 200).

`POST /ajax/squad.php`

Request body (observed verbatim): `&state=open&page=1&action=issues_get`

| Param | Type | Required | Meaning |
|---|---|---|---|
| `state` | enum `open` \| `closed` | Y | Lifecycle filter. `open` from «Открытые», `closed` from «Закрытые» |
| `page` | int (1-based) | Y | Page index. Server returns a fixed slice (page size 20 observed) |
| `action` | const `issues_get` | Y | Appended by `Action()` |

Response shape (from captured `response_schema`):

| Field | Type | Meaning |
|---|---|---|
| `status` | string enum `ok` | Success gate |
| `exec_time` | float | Server exec seconds |
| `test.getAdmin` | float | Server-side timing probe for the admin lookup (seconds) |
| `issues` | array (20 observed → **page size = 20**) | Issue records, newest-id first |
| `issues[].id` | int | Ticket number |
| `issues[].user` | string | **Reporter's admin account name** (e.g. redacted `Enj0y`) — NOT rendered in the card |
| `issues[].title` | string | Issue title / short label, rendered as the card `<label>` |
| `issues[].body` | string | Free-text description (126 chars in sample; capped 512 on create) |
| `issues[].create` | int | **Unix timestamp** — creation time |
| `issues[].update` | int | **Unix timestamp** — last-modified time (currently == `create` in sample; unused by UI) |
| `issues[].state` | string enum `open` \| `closed` | Lifecycle status |
| `issues[].labels` | array of Label | Category tags |
| `issues[].labels[].id` | int | Label id (`1`=Баг, `2`=Предложение) |
| `issues[].labels[].name` | string | Label text (e.g. `Баг`) |
| `issues[].labels[].color` | string | Hex color **without** leading `#` (e.g. `e11d21`); JS prepends `#` |
| `issues[].labels[].url` | string (nullable/empty) | Reserved link target; empty string in all observed rows |

Redacted example (single row, from captured `response_sample`):

```json
{
  "test": { "getAdmin": 0.0062 },
  "issues": [
    {
      "id": 56,
      "user": "<redacted:reporter>",
      "title": "<redacted:title>",
      "body": "При выдаче бана не всегда игрока кикает …",
      "labels": [ { "id": 1, "name": "<redacted:3>", "color": "e11d21", "url": "" } ],
      "create": 1763650640,
      "update": 1763650640,
      "state": "open"
    }
  ],
  "status": "ok",
  "exec_time": 0.516
}
```

> **Schema corrections vs. prior draft.** The record carries three fields the old chapter omitted: `user` (reporter account, distinct from `title`), `update` (second unix timestamp), and `labels[].url` (empty reserved link). `title` is server-derived and returned here — it is confirmed **not** a create-form input (create sends only `body`+`labels`).

#### 15.0.2 `issues_create` — file a new ticket (RECONSTRUCTED, not captured)

Contract source: fragment JS `issues.create.create()` in `issues.content.html`. Not observed on the wire (mutation).

`POST /ajax/squad.php`

Reconstructed body: `&body=<text>&labels=<csv>&action=issues_create` — `labels` is the multiselect `.val()` **array**, comma-joined by `Array.toString()` (e.g. `labels=1,2`; empty selection → `labels=`).

| Param | Type | Required | Meaning |
|---|---|---|---|
| `body` | string, ≤512 chars | Y (no client guard) | `#issuesModal_create-body` textarea |
| `labels` | csv of int ids (`1`,`2`) | N | Selected label ids; empty allowed |
| `action` | const `issues_create` | Y | Appended by `Action()` |

Response: envelope only (`status:'ok'` expected). On success the client discards the response body and re-issues `issues_get('open',1)`, then hides the modal — so a new ticket is assumed to land in `open`; no client-supplied state, id, `title`, or `user` (server derives them). **Destructive: Y** (creates a row).

#### 15.0.3 `uploadVideo_token` — mint a one-time upload link (RECONSTRUCTED, not captured)

Contract source: fragment JS `video.token.gen()`. Not observed (user-triggered).

`POST /ajax/squad.php`

Reconstructed body: `&action=uploadVideo_token` (called with `data:{}` → only `action` present).

| Param | Type | Required | Meaning |
|---|---|---|---|
| `action` | const `uploadVideo_token` | Y | Sole param |

Response:

| Field | Type | Meaning |
|---|---|---|
| `status` | string enum `ok` | Success gate |
| `token` | string | One-time upload credential, written read-only into `#upload-token` |

Semantics (modal help text): the link is **valid 2 hours** and **usable exactly once**. **Destructive: Y** (mints a credential / server-side state).

#### 15.0.4 `uploadVideo` — upload the MP4 (RECONSTRUCTED, not captured)

Contract source: fragment JS `video.upload()`. Not observed (multipart mutation). **Note the endpoint switch to `public`.**

`POST /ajax/public.php` — `multipart/form-data` (`processData=false`, `contentType=false`)

| Part | Type | Required | Meaning |
|---|---|---|---|
| `action` | const `uploadVideo` | Y | Appended to the `FormData` by `Action()` |
| `name` | string | N (no client guard) | `#video-name` — short title |
| `description` | string | N (no client guard) | `#video-description` — clip description |
| `file` | binary (MP4/AVI) | Y | First file from the drop-zone `input[type=file]` |
| `token` | string \| null | conditional | `getURLParameter('token')` — read from the page URL `?token=…`; null when an authenticated admin uploads directly |

Response: envelope only (`status:'ok'` expected). Client timeout `300000` ms (5 min). Upload progress is metered by the `Action()` `xhr.upload` `progress` listener, which emits `{ total: MB, upload: MB, speed: Mbit/s }` each tick. **Destructive: Y** (uploads + fans out to YouTube/Telegram).

> **Two-endpoint auth split.** Token minting is `script:'squad'` (requires an authenticated admin session); the upload itself is `script:'public'`, authorized by the one-time `token` rather than a cookie. This is the mechanism for delegating a single upload to an otherwise-unauthenticated third party.

---

### 15.1 Bug Tracker (`issues`)

#### 15.1.1 Purpose & layout

A minimal issue tracker for the panel itself (bugs and feature suggestions). Two-column split (from `issues.content.html`):

- **Left rail** (`#issues_list_buttons`, wrapped in `.block-box` `position:fixed; width:240px`): three buttons — `Создать` (Create, `.btn-success`), `Открытые` (Open, `.btn-default`), `Закрытые` (Closed, `.btn-default`).
- **Right column** (`.col-md-8`): `<ul class="list-group" id="issues_list">` (`min-height:130px`), populated by `issues.list.build()`. A `.load_block` spinner overlay shows while `issues.list.get()` runs (parent gets `.load`); an empty result appends `<h3>… Данных нет</h3>` (No data).

No DataTables grid, no server-side search, no column sorting. Filtering is by the two state buttons; paging is by the `page` integer only.

#### 15.1.2 Entity: Issue

See §15.0.1 for the authoritative field-by-field schema. Summary:

| Field | Type | Rendered? | Notes |
|---|---|---|---|
| `id` | int | Yes — `<hashtag>#id</hashtag>` | Ticket number |
| `user` | string | **No** | Reporter account (present in payload, unused by card) |
| `title` | string | Yes — `<label>` | Server-derived |
| `body` | string | Yes — `<p>` | ≤512 chars on create |
| `state` | enum `open`\|`closed` | Yes — `<code>` pill | `open`→green `Открыто` + unlock icon; `closed`→grey `Закрыто` + lock icon |
| `create` | unix int | Yes — `formatDate()` `<small>` | e.g. `20/11/2025 15:57:20` |
| `update` | unix int | No | Present, unused |
| `labels[]` | array | Yes — `<span class="label">` | See below |

Entity: **Label** (embedded array)

| Field | Type | Meaning |
|---|---|---|
| `id` | int | Label id (`1`/`2`) |
| `name` | string | Text, rendered with `fa-tag` icon |
| `color` | string | Hex **without** `#`; JS builds `background-color:#`+`color` |
| `url` | string | Empty in all observed rows (reserved) |

Create-form label options (hard-coded in `#issuesModal_create-labels`):

| `value` | Label | Color | Rendered pill |
|---|---|---|---|
| `1` | Баг (Bug) | `#e11d21` (red) | red `label label-default` |
| `2` | Предложение (Suggestion) | `#207de5` (blue) | blue `label label-default` |

#### 15.1.3 The list ("table")

Rendered as cards, not a `<table>`. `issues.list.build(data)` emits one `<li class="list-group-item">` per issue:

| Card row | Markup | Content |
|---|---|---|
| Header | `<p>` | `<hashtag>#id</hashtag>` + `<label>title</label>` + pull-right state `<code>` pill + `<small>formatDate(create)</small>` |
| Body | `<p>` | `body` verbatim (server-escaped) |
| Labels | `<p>` | one `<span class="label label-default" style="background-color:#{color}">` per label |

Filter / sort / pagination:

| Control | Trigger | Effect |
|---|---|---|
| Open state | `issues.list.get('open',1)` | Fetch `state=open,page=1` |
| Closed state | `issues.list.get('closed',1)` | Fetch `state=closed,page=1` |
| Pagination | `get(state, page)` param exists | **No page-nav UI** — buttons hard-code `page=1`; server supports paging (20/page), frontend does not expose it |

No search box, no per-column sort.

#### 15.1.4 Actions / capabilities

| UI label | Trigger | action | Endpoint | Data keys (types) | Effect | Destructive |
|---|---|---|---|---|---|---|
| Открытые (Open) | `issues.list.get('open',1)` | `issues_get` | `POST /ajax/squad.php` | `state:string`, `page:int` | Fetch open → rebuild list | N |
| Закрытые (Closed) | `issues.list.get('closed',1)` | `issues_get` | `POST /ajax/squad.php` | `state:string`, `page:int` | Fetch closed → rebuild list | N |
| Создать → open modal | `issues.create.show()` | — | client only | — | Opens `#issuesModal_create`, inits multiselect | N |
| Создать → submit | `issues.create.create(this)` | `issues_create` | `POST /ajax/squad.php` | `body:string(≤512)`, `labels:int[]→csv` | Create ticket, reload open list, hide modal | **Y** |

Behavioral notes:

- During `issues_get`, `disable_buttons(true)` calls `.btnload('')` on all three rail buttons; `complete` re-enables via `.btnreset()`.
- On `issues_create` submit, `btn.btnload('Создаём')`; success/error both `btn.btnreset()`.
- **No close / reopen / edit / delete / comment action exists in this fragment.** The `closed` state and `update` field exist in data, but no UI here transitions an issue — admins can only create and read. Thin CRUD surface.

#### 15.1.5 Create modal (`#issuesModal_create`)

| Element | `#id` | Type | maxlength | Options / default | Validation |
|---|---|---|---|---|---|
| Описание проблемы (Problem description) | `issuesModal_create-body` | `textarea` rows=4 | `512` | — | None client-side (empty submit possible) |
| Метки (Labels) | `issuesModal_create-labels` | `<select type="multiselect" multiple>` → Bootstrap `multiselect` | — | opts `1`=Баг, `2`=Предложение; `nonSelectedText:'- Метки -'`, `enableHTML:true`; default none | Optional; sends csv of ids |
| Создать (Create) | — (`onclick`) | `.btn-success` button | — | — | `btnload('Создаём')` during submit |

`enableHTML:true` lets each option's `label` attribute render as a colored pill (`Баг` red / `Предложение` blue) inside the dropdown.

#### 15.1.6 Permissions / visibility

No `class="hide"`, no role/group gating in the fragment. Both read and write actions hit `script:'squad'` — access control is entirely upstream (whether `page.php?page=issues` is served). No DOM-level gating.

---

### 15.2 Video / Demos (`video`)

#### 15.2.1 Purpose & layout

A big-file uploader for demo/evidence videos. Backend fan-out is stated verbatim in the modal: **Браузер → Sqstat → YouTube + Telegram**. Header links target `t.me/sqstat` and YouTube channel `UC8Sofbi4vR6NxD9TJ59KiZg`. Layout (from `video.content.html`):

- **Header row** (`<h3 class="text-center">`): Telegram link, YouTube link, pull-right `Генерировать ссылку` (Generate link) button → `video.token.show()`.
- **Drop zone** `#drag.drop_file_zone` (`height:76vh`): full-height area with `<h2 id="load_state">… Загрузите файлэ</h2>` and a `(2ГБ)` size hint. Contains hidden `<input type="file" accept=".mp4,.avi">`.
- Two modals: `#loadModal` (upload metadata + progress) and `#tokenModal` (token generation).

#### 15.2.2 Entity: Video upload

Fields per §15.0.4. Accepted extensions: `['.mp4','.avi']` (drop handler `dragFile(['.mp4','.avi'])`; the `<input accept>` is rewritten to `.mp4,.avi` by `dragFile`). Advertised ceiling **2 GB**. Client timeout **300 s**.

> **No structured linkage.** The payload carries only free-text `name`/`description` plus `file`/`token` — no match id, server id, round id, SteamID/UUID, or player selector. Any association to a match or offender is human-entered prose, not a foreign key.

#### 15.2.3 Entity: Upload token

| Field | Type | Meaning |
|---|---|---|
| `token` | string | One-time credential from `uploadVideo_token`, shown read-only in `#upload-token` |

Semantics: **valid 2 hours, single use** («Ссылка доступна для загрузки 2 часа, загрузить можно 1 раз»). Intended for delegated uploads — an admin mints a link and hands it to a third party; the upload page reads it from `?token=…` and attaches it to `uploadVideo`.

#### 15.2.4 Actions / capabilities

| UI label | Trigger | action | Endpoint | Data keys | Effect | Destructive |
|---|---|---|---|---|---|---|
| Генерировать ссылку → open modal | `video.token.show()` | — | client | — | Opens `#tokenModal` | N |
| Создать токен (Create token) | `video.token.gen()` | `uploadVideo_token` | `POST /ajax/squad.php` | `{}` (action only) | Returns `token` → `#upload-token` | **Y** |
| Загрузить (Upload) | `video.upload()` | `uploadVideo` | `POST /ajax/public.php` | FormData: `name:string`, `description:string`, `file:binary`, `token:string\|null` | Upload MP4/AVI; backend → YouTube + Telegram | **Y** |

#### 15.2.5 Upload modal (`#loadModal`) — fields & UX

| Element | `#id` | Type | Notes |
|---|---|---|---|
| Название видео (Video name) | `video-name` | text | Placeholder `Название видео`; help «Короткое название видео. Например "Нарушение правил Enj0y"» |
| Описание видео (Video description) | `video-description` | textarea rows=2 | Help «Опишите что происходит на видео» |
| Загрузить (Upload) | `video-upload` | `.btn-success` button | Hidden during upload (`.hide()`); triggers `video.upload()` |
| Progress bar | `load_bar` | `.progress-bar` div | Width % live; inner `<h2>` shows `%` |
| Progress detail | `load_bar-upload_progress` / `load_bar-upload_speed` | spans | `"<upload> / <total> МБ"` and `"<speed> Мбит/c"` |

No client-side field validation (name/description may be blank; only extension is checked in the drop handler). During upload the modal is made non-dismissable: a `hide.bs.modal` handler calls `e.preventDefault()`; on success the handler is detached (`.off('hide.bs.modal')`) after a 4 s delay, on error immediately. On error the bar flips to `.progress-bar-danger` and `#load_state` shows «Не удалось загрузить файл».

Progress metering (`Action()` `xhr.upload` listener, `custom.js:363`): computes `total` MB, `upload` MB, and `speed` in Mbit/s (`((uploadedkBytes/elapsed)/1024)*8`) each tick. Help text warns YouTube has a daily quota (posts «сразу, или на следующий день») whereas Telegram posts «сразу» — differing latency guarantees.

#### 15.2.6 Token modal (`#tokenModal`)

| Element | `#id` | Type | Notes |
|---|---|---|---|
| Token field | `upload-token` | text `readonly` | Displays minted token |
| Создать токен (Create token) | `generate-token` | `.btn-success` button | Calls `video.token.gen()`; `btnreset(600)` cooldown after |
| Help | — | — | «Ссылка доступна для загрузки 2 часа, загрузить можно 1 раз» |

> **Bug.** `gen` is bound as `onclick="video.token.gen()"` (no arg) but the body reads `gen: function(btn){ $btn = $(btn); … }` — `btn` is `undefined`, so `$btn` is an empty jQuery set and the `btnload()`/`btnreset()` spinner silently no-ops. The `Action()` call itself still fires and populates `#upload-token`.

#### 15.2.7 Drag-and-drop mechanics

`$.fn.dragFile(ext)` (`custom.js:451`) wires `#drag`: on `drop` (or `click`) it takes `files[0]`, lowercases the extension, and rejects (`return false`) if `ext.indexOf('.'+file_ext) == -1`. Valid files are injected into the hidden `<input type=file>` via a synthetic `DataTransfer` and re-fired as an `end` event carrying `[file, file.name]`. `dragFile` also rewrites the input `accept` attr to `ext.join(',')` and toggles `.drop_file_zone-hover` on `dragenter`/`dragover`. The fragment's `init()` listens for `end` (open `#loadModal`; a null file → `alert('Ошибка файла')`), plus `start`/`progress`/`error` (console logging only). The `FileReader` binary-read path in `dragFile` is commented out — only the `DataTransfer` injection path is live.

#### 15.2.8 Permissions / visibility

No `class="hide"` or role checks in the fragment. Security is endpoint-based:

- Loading `video` and minting a token require the authenticated `squad` context.
- The `public` upload endpoint trusts the one-time, 2-hour, single-use `token` — the delegation mechanism for non-admins.

---

### 15.3 Competitively interesting takeaways

- **Two-endpoint upload auth (`squad` mint + `public` consume):** clean pattern for player evidence submission without accounts. Easy to beat by binding the token to a specific report/match id so footage auto-links to a case.
- **No structured video↔match/player/report linkage** — only free-text `name`/`description`. A panel that attaches demos to a match/kill/ban record (foreign keys, jump-to-timestamp) is strictly more useful.
- **Fan-out to YouTube + Telegram with quota-aware messaging** — storage externalized to free platforms (2 GB clips), YouTube quota honored. Cheap hosting, but no in-panel playback and inconsistent latency.
- **Bug tracker is create/read only** — `state=closed`, `page`, and `update` exist in the API but no UI wires status transitions, pagination, or edits. A richer tracker (assignee, comments, close/reopen, search, real pagination) is an easy differentiator.
- **Reporter identity is captured but hidden** — `issues[].user` is returned yet never rendered; surfacing "filed by / assigned to" is a trivial UX win.
- **512-char body cap, two labels (Bug/Suggestion)** — deliberately lightweight; for panel feedback, not game moderation.
