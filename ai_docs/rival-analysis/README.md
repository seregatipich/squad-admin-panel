# Rival Analysis — SQSTAT (`breaking.sqstat.ru`)

Competitive functionality analysis of the rival SQUAD server admin panel **SQSTAT**, for benchmarking against this project's `squad-admin-panel`.

Produced in two passes, both **strictly read-only** (no state changed on the rival panel): (1) a 24-agent parallel documentation pass over a captured corpus + static analysis of the client bundle; (2) a **parallel-browser live-capture pass** — a fleet of subagents each drove its **own** headless Chromium (authenticated via the session cookie) behind a network interceptor that aborts any mutating action, capturing the **real AJAX request/response contracts** so every chapter is spec-grade (exact endpoints, params, response field types). Date: 2026-07-04.

## Start here

- **[`SQSTAT-rival-panel-analysis.md`](SQSTAT-rival-panel-analysis.md)** — the complete single-file report (executive summary + all 25 chapters + screenshot index). ~660 KB. Each chapter carries a **"Live API Contracts"** block.

## Structure

- **[`sections/`](sections/)** — the 25 modular chapters that make up the master report:
  - `00` Overview & Architecture · `01` Dashboard/RCON · `02` Chat
  - `03` Players · `04` Player profile · `05` Admins/Groups/Permissions · `06` VIP · `07` Online · `08` Comments/Marks · `09` Bans · `10` Ban-names & Ru-Bans
  - `11` Statistics · `12` Games · `13` Combat logs · `14` Votes/Reports · `15` Issues/Video · `16` Settings · `17` Audit journal
  - `18` Clans · `19` API · `20` Top
  - `90` Permission model · `91` Data model · `92` Per-player storage · `93` Action/RPC catalog
- **[`screenshots/`](screenshots/)** — 16 full-page captures of every major surface.

## Key facts at a glance

| | |
|---|---|
| Stack | PHP + Steam OpenID; jQuery 2.2 / Bootstrap 3.3 AJAX SPA; Chart.js, Leaflet, FullCalendar, CodeMirror; separate RCON bot/parser |
| API shape | `pageLoad()` → `GET /ajax/page.php?page=X` (views); `Action({script,action})` → `POST /ajax/<script>.php` (mutations). Scripts: `public, table, player, squad, clan, settings` |
| Actions | ~90 action ids (full catalog in ch. 93) |
| Auth model | 3 stacked layers (panel role / in-game Squad tokens / clan ownership), 5 groups; **no unified RBAC** (ch. 90) |
| Data scale | ~385k players, ~115k+ journal entries, ~80 clans, 53 staff, 6 servers |
| Monetization | VIP (QueuePriority group), subscriptions, bonus-points economy, paid clan servers |
| Standout features | shared cross-community ban network (Ру-Баны), deep per-player dossier w/ EOS ID + IP geolocation + twin detection, full RCON incl. CodeMirror config editor & rotation calendar |

> Note: raw captured HTML fragments and the session cookie used for read-only fetches were kept only in the ephemeral job scratch dir and are **not** committed. This folder contains documentation and screenshots only.
