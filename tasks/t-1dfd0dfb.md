---
id: t-1dfd0dfb
title: Dashboard: roles, chunked project delete, D1 scan costs, cache headers
status: done
added: 2026-10-05
priority: high
---

## Description

From the 2026-10-05 dashboard audit (swiftstats.co): enforce project roles (owner for keys/settings/delete/icon); deleteProject revokes keys + membership first then deletes events in chunks; createProject refuses an id with surviving raw rows; apps.ts MAX(ts) unbounded scan → MAX(day) via events_scope; loadKeyEvents/dailyCountsByName filter to names; cap event_catalog rows from POSTs; per-project raw window instead of hard-coded 90 (dashboard.ts:258, settings.ts:57, copy); Cache-Control: no-store on authenticated HTML + mint responses; verification rows expiry; seq±1 joins tolerate gaps; /app bound-param cap. Magic-link prefetch/login-CSRF (confirm page that POSTs) — design call. Relay fix + backslash return-to handled on site-fixes.

## Plan



## Artifacts



