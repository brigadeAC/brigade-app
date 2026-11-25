# Group Classes: build spec (step 1, no billing)

Replaces the class side of Wodify: schedule, reservations, attendance, plan limits.
No money in this step (memberships are assigned by staff; Stripe comes later).
Read this fully before writing code. Patterns to copy: `docs/programs-spec.md` and the
Programs code (`functions/api/[[path]].js` program functions, `src/pages/Programs.jsx`,
`src/components/programs/*`). Research (local only): `content/wodify/*.md`.

## Safety / rollback (all agents)
- Work happens on git branch `classes`. Production (`main`, tag `pre-classes`) is untouched.
  Do NOT commit, push, merge, deploy, or touch `dist/`. The integrator does that.
- Additive only: new entity types and new functions. Do not change behavior of existing
  features, existing entity types, or existing permission rules except adding new type names
  to the sets described below.
- Never run anything against the remote/production database. Backend testing uses
  `npx wrangler pages dev` with the LOCAL D1 only (no `--remote`).
- Compile check: `npx vite build --outDir /tmp/brigade-build-<agent> --emptyOutDir`,
  and `npx eslint <your files>`.
- Only edit files you own (see Ownership). Need a change elsewhere? Say so in your report.

## Ground rules (same as programs-spec)
- Data belongs to the gym or the client, never a coach. Staff = admins + trainers, all see the same data.
- Times: the gym is in America/New_York. Class dates are local `yyyy-MM-dd`, times `HH:mm`
  Eastern. Store `start_at`/`end_at` as ISO UTC computed from Eastern (backend has `PROGRAM_TZ`
  and Eastern conversion helpers for program messages; reuse them). Frontend: date helpers in
  `src/lib/programs.js` (never `new Date("yyyy-MM-dd")`).
- UI: shadcn/ui + Tailwind tokens, mobile-first (members book on phones), copy style from
  `src/pages/HabitLibrary.jsx`. No hype copy, no exclamation points.

## Entities
### ClassType (gym library: everyone reads, staff writes)
`name, description, color (hex), reservable (bool; false = open gym style, check-in only),
default_capacity (number|null = uncapped), default_duration_min, is_active, sort`
Seed suggestion shown as empty-state buttons (not auto-created): CrossFit (cap 20, 60 min),
Open Gym (not reservable), Women's Functional Strength (cap 20, 60 min).

### ClassSlot (gym library) - a recurring weekly time
`class_type_id, day_of_week (0=Sun..6), start_time "HH:mm", duration_min, capacity (null = use
type default; uncapped if both null), coach_user_id, coach_name, start_date, end_date (optional),
is_active`

### ClassSession (gym library; generated) - one dated class
`class_type_id, class_type_name, color, slot_id (null for one-offs), date, start_time, end_time,
start_at, end_at (ISO UTC), capacity, coach_user_id, coach_name, status: scheduled|cancelled,
cancel_reason, reservable, notes, reserved_count, waitlist_count, checked_in_count,
booking_open_hours? (copied from slot, else class type), overrides?: { booking_open_hours, booking_close_minutes, late_cancel_hours }`
  Booking window: overrides (this class) > booking_open_hours (slot, else type) > GymSettings. UI edits it in days.
  Generation extends past `generate_days_ahead` when a window is longer (max 62 days).
- Generated from active slots for the next `generate_days_ahead` days (default 21). Idempotent:
  never two sessions with the same (slot_id, date). Editing a slot updates FUTURE sessions of
  that slot that have no reservations; sessions with reservations keep their time unless
  staff edits the single session. Deactivating a slot cancels its future empty sessions and
  leaves booked ones for staff to cancel explicitly (report count back to the UI).
- Counts are maintained by the backend whenever reservations change.

### Reservation (client record; members write ONLY through functions)
`session_id, class_type_id, class_name, date, start_at, client_id, client_user_id, client_name,
status: reserved|waitlisted|cancelled|late_cancelled|checked_in|no_show|cancelled_by_gym,
waitlist_position, membership_id, booked_at, cancelled_at, checked_in_at,
check_in_method: self|coach|walk_in, booked_by (user id)`
- A reservation is not attendance. Only `checked_in` counts as a visit.

### MembershipPlan (gym library)
`name, kind: unlimited|limited|punch|intro|comp|drop_in, limit_count (number|null),
limit_period: week|month|total|null, class_type_ids (array; empty = all class types),
duration_days (for punch/intro expiry; null = no expiry), price_label (display text only,
e.g. "$189/mo"), description, is_active, sort`
Empty-state seed buttons for Brigade's real plans: Unlimited (unlimited), Silver 3x/week
(limited, 3/week), 10-Class Punch Card (punch, 10 total, 90 days), 7 Days for $7 (intro,
unlimited, 7 days), Free Trial (intro, 7 days), Drop-In (drop_in, 1 total, 1 day),
Coach/Scholarship (comp, unlimited).

### Membership (client record; staff writes)
`client_id, client_user_id, client_name, plan_id, plan_name, kind, limit_count, limit_period,
class_type_ids, start_date, end_date (null = ongoing; punch/intro default start+duration_days-1),
sessions_total (punch/drop-in), sessions_used, status: active|on_hold|ended, hold_from, hold_to,
notes`
Plan fields are copied onto the membership at assignment (template edits don't change
existing memberships, same idea as habits).

### GymSettings (single record, gym library; staff writes) - read with defaults if missing
`booking_open_hours 168, booking_close_minutes 60, late_cancel_hours 8,
self_checkin_before_minutes 30, self_checkin_after_minutes 30 (reserved classes, relative to
start), open_gym_checkin_until_end true, no_show_after_minutes 120 (after class end),
waitlist_enabled true, late_cancel_counts_toward_limit false, no_show_counts_toward_limit false,
waiver_required true, show_roster_to_members true, generate_days_ahead 21`
(These defaults are Brigade's current Wodify settings.)

## Business rules (backend enforces; frontend mirrors for messaging)
Booking `bookClass({ session_id, client_id? })` (member books self; staff may pass client_id):
1. Session scheduled, reservable, not started-past-close: now <= start_at - close window, and
   now >= start_at - open window (staff bypass windows).
2. Client has a login-linked Client record; not already reserved/waitlisted/checked-in.
3. Waiver: if `waiver_required`, the client must have a signed waiver. Look at how `Contract`
   records are stored (`src/pages/Contracts.jsx`, `src/pages/ClientDocuments.jsx`,
   `src/components/contracts/*`): treat a Contract for that client with status `signed` whose
   type/title marks it as a waiver as satisfying it. If no waiver concept exists, add
   `type: "waiver"` support minimally and document it. Staff can bypass with a warning.
4. Membership: an active membership on that date (start<=date<=end, not on hold) whose
   class_type_ids is empty or includes the class type, with remaining allowance:
   - week: count of that membership's reservations in status reserved|checked_in (plus
     late_cancelled/no_show if the settings say they count) in the Mon-Sun Eastern week of
     the class date < limit_count.
   - month: same, over the membership's billing month (anchored on start_date's day of month).
   - total (punch/drop-in): sessions_used + currently reserved (future, not checked in) < total.
   - unlimited/comp/intro: no count limit.
   Pick the first qualifying membership: limited/punch before unlimited? No: prefer
   unlimited/comp/intro first (so punch cards aren't spent when an unlimited plan covers it),
   then limited, then punch. Record `membership_id`.
   No qualifying membership -> clear error ("No active membership covers this class.").
5. Capacity: if reserved_count < capacity (or uncapped) -> `reserved`; else if waitlist enabled
   -> `waitlisted` with next position; else error "Class is full."
Cancel `cancelReservation({ reservation_id })`: member (own) or staff.
- Before start_at - late_cancel_hours -> `cancelled`; inside -> `late_cancelled` (no fees in
  this step). Waitlisted -> just `cancelled`.
- Frees a spot: promote the first waitlisted to `reserved` ONLY if now is before the late-cancel
  cutoff (never auto-add inside it) and their membership still qualifies; notify them
  (Notification + push, link '/ClientClasses').
Check-in `checkIn({ session_id, client_id? })`:
- Member self: within [start - before, start + after] for reservable classes; requires a
  reservation (if none and a spot + membership qualify, book and check in in one step).
  Non-reservable (open gym): anytime from `before` until class end, no reservation needed,
  membership still required.
- Staff (roster): any time that day; can check in walk-ins (creates the reservation,
  check_in_method walk_in; membership check with staff override allowed and flagged).
- Punch/drop-in: increment membership.sessions_used at check-in. `undoCheckIn` (staff)
  reverts to reserved and restores the session.
- `markNoShow` / convert no-show to checked_in (staff). Converting restores counts.
Automatic tick `classTick` (add to the existing cron route `POST /api/cron/program-tick`
by calling it after runProgramTick, and expose `functions.invoke('classTick')` for staff):
- Generate sessions to the horizon.
- Mark `reserved` as `no_show` when now > end_at + no_show_after_minutes.
Cancel a class `cancelClassSession({ session_id, reason })` (staff): status cancelled, every
active reservation -> cancelled_by_gym (restore any punch counts), notify each client.
Reads:
- `classSchedule({ from, to })` (any signed-in user): sessions with counts; for members also
  `my_reservation` (status) per session and, if `show_roster_to_members`, attendee first name +
  last initial list; staff get full roster via `classRoster({ session_id })`.
- `myClasses()` (member): upcoming reservations + recent attendance + active memberships with
  remaining allowance this week/month/total + waiver status.
- `classMemberStatus({ client_id })` (staff): same summary for a client profile.

## Permissions (backend)
- Add ClassType, ClassSlot, ClassSession, MembershipPlan, GymSettings to STAFF_LIBRARY_TYPES
  (everyone reads, staff writes).
- Membership: staff write; members read own (client_id / client_user_id).
- Reservation: members read own; members may NOT create/update/delete directly (all writes via
  the functions above, which run with server authority). Staff may write.
- Members must never see other members' reservations through entity list; roster names only
  via classSchedule's limited first-name list.

## Frontend ownership
| Agent | Owns |
|---|---|
| `classes-backend` | `functions/api/[[path]].js` (new functions, permission sets, cron hook), `docs/classes-backend-test.md` (curl tests it actually ran against local `wrangler pages dev`) |
| `classes-coach` | `src/pages/Classes.jsx` (coach: day/week view of sessions, tap -> roster sheet with check-in / undo / no-show / walk-in / cancel class), `src/pages/ClassSetup.jsx` (tabs: Class types, Weekly schedule (slots grid by weekday), Membership plans, Booking settings), `src/components/classes/coach/*`, a "Membership" section/tab in `src/pages/ClientProfile.jsx` (assign plan, start date, hold, end; shows usage + recent attendance via classMemberStatus), and nav: add "Classes" and "Class Setup" to the coach nav in `src/Layout.jsx` (new group "Group Classes"), add `ClientClasses` to the client pages list in `src/Layout.jsx` and to `src/components/ClientBottomNav.jsx` / client nav where Schedule-like items live |
| `classes-member` | `src/pages/ClientClasses.jsx` (week day-strip, list of sessions with spots left/full/waitlist, Book / Cancel / Join waitlist / Check in buttons with clear reasons when disabled, "My classes" upcoming list, membership allowance line), `src/components/classes/member/*` including `NextClassCard` rendered near the top of `src/pages/ClientDashboard.jsx` (next booked class + Check in button when the window is open), `src/lib/classes.js` (shared client helpers: function wrappers, status labels/colors, window math mirroring the backend) |

`classes-member` writes `src/lib/classes.js` FIRST (wrappers for every function above with the
exact payload names in this spec) so `classes-coach` can import it. `classes-coach` may
create its own helpers under `src/components/classes/coach/` if needed sooner.

## Done means
Files build + lint clean; report lists every file changed, assumptions, and anything needed
from a file you don't own. Backend: every function exercised locally with curl, results noted.

## Rollback reference (integrator)
- Code: `git switch main` / production was deployed from tag `pre-classes`.
- Data (production D1 restore point taken before this build, 2026-11-21):
  `npx wrangler d1 time-travel restore brigade-app --bookmark=00000065-00000000-0000512a-87832dba1de551b0c68ac99a808def47`
  (or just delete rows whose entity_type is one of the new class types).
