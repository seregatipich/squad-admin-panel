# Plan for fixing the role expiry selection (#268)

## Goal

Make both role assignment forms unambiguous and identical: the operator sees
the date only as `ДД/ММ/ГГГГ` (DD/MM/YYYY), opens the calendar by clicking anywhere in the field area,
and understands the purpose of the optional comment.

## Decisions made

- One shared `RoleExpiryDateField` is used in the `/users` modal and in
  the role editor of the player card.
- The external representation of the date does not depend on the browser language: the selected
  `YYYY-MM-DD` is displayed as `ДД/ММ/ГГГГ`.
- A button the size of the whole field synchronously calls the native `showPicker()`.
  The hidden `input[type=date]` remains the source of the calendar and the ISO value without
  a new dependency.
- An empty value means a permanent role. The selected date is inclusive of the whole day:
  the API receives the last millisecond of the selected UTC day. This gives a
  stable round trip back to the date regardless of the browser's time zone.
- Under the field the end-of-day and permanence rule is stated explicitly. Under the comment,
  that it is an optional reason visible to other administrators.

## Steps

1. Add red unit checks for the date conversion, the strict Russian
   representation, opening the calendar from the whole button, and clearing the value.
2. Add red checks for both real forms: no
   `datetime-local`, clear labels present, and the `ДД/ММ/ГГГГ` format.
3. Implement the shared component and the UTC conversions, and wire them into both forms.
4. Update the web component documentation and the browser scenarios for `/users` and
   the player card.
5. Run the red/green check, typing, Biome, the build and a real
   Playwright acceptance at desktop and mobile widths.
6. Read the full diff yourself, merge the branch into `dev`, wait for green
   CI, then fast-forward the same SHA to `master`, verify the release and leave
   full readiness confirmation in the issue.

## Out of scope

- Changing the API or the DB schema.
- Changing the exact calendars of the scheduler: there the time of day is part of the
  domain contract and `datetime-local` remains correct.
- Adding a third-party calendar library.
