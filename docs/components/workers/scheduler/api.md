# worker-scheduler — API surface

The API routes are owned by `apps/api/src/routes/server-rotation-calendar.ts`:

- `GET /api/v1/servers/:id/rotation-schedule` returns scheduled entries, match
  history, weekly profiles, conflict warnings, and `can_edit`.
- `POST`, `PATCH`, and `DELETE /api/v1/servers/:id/rotation-schedule` manage
  one-off layer changes.
- `PUT /api/v1/servers/:id/rotation-profiles` replaces the default and weekday
  managed-segment profiles.

Reads require `panel_access`; mutations require the Squad `changemap`
permission. Mutation audit entries are emitted by the API, while scheduler
execution emits `server.rotation_schedule.execute` and
`rotation.profile_applied`.
