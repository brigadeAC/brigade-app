# Group Classes backend: what was built and the curl tests that were run

All tests below were run on 2026-11-21 (Sat, ~14:55-15:15 Eastern) against
`npx wrangler pages dev dist --local --port 8788` with the LOCAL D1 only. No
`--remote`, no deploy, no commit. Test rows (users `*.cls@example.test`,
clients `cl_m1..cl_m3`, contracts `ct_m1..ct_m3`, the class types/plans/sessions
below) remain in the local D1 only; delete them with
`DELETE FROM entities WHERE created_by='coach.cls@example.test' OR id LIKE 'cs_%'` etc. if needed.

## Deviations / additions vs docs/classes-spec.md (read this first)

Names and payloads in the spec are unchanged. Additions and interpretations:

1. **reserved_count = spots taken = reserved + checked_in.** `checked_in_count` is a subset of it.
   Capacity checks use reserved + checked_in. `capacity` null, missing or `<= 0` = uncapped.
2. **Extra function `classCoaches()`** (staff): `{ success, coaches: [{id, full_name, email}] }`.
   `User.list()` for a trainer still returns only themselves (existing rule, left unchanged); admins get all users.
   The coach picker should use `classCoaches`.
3. **Entity-route hooks for class types (staff writes only):**
   - `POST/PUT ClassSlot` (and DELETE) immediately syncs that slot's sessions; the response carries
     `class_sync: { generated, revived, updated, cancelled, booked_kept, booked_sessions: [{id,date,start_time,reserved_count}] }`.
     `booked_sessions` = future sessions with reservations that were NOT moved/cancelled (staff must handle them).
     `classTick` does the same sync for all slots, so "PUT slot then classTick" also works (tested).
   - `PUT/POST ClassType` re-syncs that type's slots (name/color/capacity defaults propagate to empty future sessions).
   - `POST ClassSession` (one-off) fills `class_type_name, color, reservable, capacity` from the type, computes
     `start_at/end_at/end_time/duration_min`, sets `status: scheduled`, counts 0, `slot_id: null`.
   - `PUT ClassSession` recomputes times if date/start_time/end_time/duration_min change (start move keeps
     duration; explicit end_time sets duration), sets `edited_manually: true` on time/capacity edits (slot
     sync never touches it afterwards), recounts, and promotes the waitlist if capacity grew.
     If staff PUTs `status: "cancelled"` the reservations are cancelled exactly as in `cancelClassSession`.
     Count fields sent by the client are ignored.
   - `POST Membership` copies plan fields the caller left out (plan_name, kind, limit_count, limit_period,
     class_type_ids, sessions_total for punch/drop-in, end_date = start + duration_days - 1, sessions_used 0,
     status active, client_name, client_user_id).
   - Staff writes to `Reservation` via the entity API recount the affected session(s).
4. **Slot-removed sessions** are cancelled with `auto_cancelled: true, cancel_reason: "Removed from the weekly schedule"`
   and hidden from `classSchedule`. Re-activating the slot revives them. Session ids for generated sessions are
   deterministic: `cs_<slotId>_<yyyy-MM-dd>` (INSERT OR IGNORE = idempotent even with concurrent ticks).
5. **undoCheckIn** reverts to `reserved`, EXCEPT reservations that were created by the check-in itself
   (walk-in, open gym, book-and-check-in; flagged `created_at_checkin: true`): those go to `cancelled`, so an
   undone walk-in doesn't hold a spot.
6. **Staff overrides:** `bookClass` / `checkIn` accept `override: true` from staff to bypass membership and capacity
   (reservation gets `membership_override: true`). Without it, failures return `code` plus `can_override: true`.
   Missing waiver never blocks staff; it returns `warnings: ["No signed waiver on file."]`.
   `cancelReservation` accepts `waive_late_cancel: true` from staff.
7. **Staff check-in** is allowed on the class date or later (for corrections), not on future dates.
   `markNoShow` requires the class to have started.
8. **classTick** also cancels still-`waitlisted` reservations of sessions that have ended (`waitlist_expired: true`).
9. **Waiver** = a `Contract` for any of the client's ids (Client id or login id) with `status: "signed"` and
   `type: "waiver"` or a title containing "waiver" (case-insensitive). No new waiver concept was needed.
10. **Notifications** for promotion / class cancelled: `Notification {user_id, type:"class", title, message,
    link:"/ClientClasses", read:false}` + web push (sent with server authority, `created_by` = acting staff or
    the session coach so the member can dismiss it).
11. Cron: `POST /api/cron/program-tick` now returns `{ ...programTickResult, classes: classTickResult }`
    (class tick errors are caught and reported in `classes`, never break program delivery).

## Functions (POST /api/functions/<name>); errors are `{ success:false, error, code? }` with HTTP 200

| Function | Who | Payload | Returns (success) |
|---|---|---|---|
| `classSchedule` | any signed-in | `{from?, to?}` (default today..+6, max 62 days) | `{ success, from, to, today, now, settings, sessions: [ClassSession + spots_left, is_full, windows{booking_opens_at, booking_closes_at, late_cancel_at, checkin_opens_at, checkin_closes_at}, (members only) my_reservation {id,status,waitlist_position,checked_in_at} or null, attendees [{name:"Alice A."}] if show_roster_to_members] }` |
| `classRoster` | staff | `{session_id}` | `{ success, session (+windows), reservations: [Reservation + membership_name, membership_kind, waiver_signed] }` (all statuses) |
| `myClasses` | member | `{}` | `{ success, client, today, upcoming: [Reservation + start_time, end_time, end_at, color, overrides, reservable, coach_name, session_status], recent, recent_attendance (same as recent), memberships: [Membership + allowance{period,limit,used,remaining,(period_start,period_end)|(checked_in,reserved)}, remaining, used_this_week, used_this_month], waiver {required, signed, contract_id}, stats {visits_30d, no_shows_30d, late_cancels_30d, total_visits}, settings }`. No linked client -> success with empty lists and `notice`. |
| `classMemberStatus` | staff | `{client_id}` | same as myClasses + `all_memberships` (incl. ended) |
| `classCoaches` | staff | `{}` | `{ success, coaches }` |
| `bookClass` | member (self) / staff | `{session_id, client_id?, override?}` | `{ success, status: reserved|waitlisted, reservation, session, warnings }` |
| `cancelReservation` | member (own) / staff | `{reservation_id, waive_late_cancel?}` | `{ success, status: cancelled|late_cancelled, late_cancel, promoted (count), reservation, session }` |
| `checkIn` | member (self) / staff | `{session_id, client_id?, reservation_id? (staff), override?}` | `{ success, reservation, session, warnings, already? }` |
| `undoCheckIn` | staff | `{reservation_id}` or `{session_id, client_id}` | `{ success, reservation, session }` |
| `markNoShow` | staff | `{reservation_id}` or `{session_id, client_id}` | `{ success, reservation, session }` |
| `cancelClassSession` | staff | `{session_id, reason}` | `{ success, session, affected, notified }` |
| `classTick` | staff (and cron) | `{}` | `{ success, generated, revived, updated, cancelled, booked_kept, booked_sessions, no_shows, waitlist_expired }` |

Error `code`s: `waiver_required, no_membership, limit_reached, class_full, already_booked, booking_not_open,
booking_closed, class_cancelled, not_reservable, class_over, checkin_not_open, checkin_closed, waitlisted,
not_cancellable, class_started, not_checked_in, invalid_status, class_not_started, no_client, retry`.

## Race safety
- A booking is ONE conditional `INSERT ... SELECT ... WHERE` that re-checks, inside SQLite: session still
  scheduled, no active reservation for the client, spots taken < capacity, and the membership allowance guard
  (week/month count or sessions_used + reserved < total). Waitlist insert requires the class to still be full
  and computes the next position in the same statement.
- Promotion is a conditional UPDATE (`status='waitlisted'` AND capacity AND allowance).
- Check-in/undo/no-show/cancel: punch-card increment/decrement and the status change run in one D1 `batch`
  (a transaction), and the membership update is conditioned on the reservation still being in the expected status,
  so a double tap can't double-punch.
- Counts are recomputed from the reservations with one UPDATE after each change (never incremented).

## How the tests were run
Scripts live in the session scratchpad; they are reproduced verbatim here. Shared helpers:
```sh
API=http://localhost:8788/api
H='content-type: application/json'
REPO=/Users/ericgriffith/Downloads/brigade-app
sql() { (cd $REPO && npx wrangler d1 execute brigade-app --local --command "$1" 2>&1 | grep -v '^$' | tail -n +1 >/dev/null); }
fn() { local tok=$1 name=$2 body=${3:-'{}'}; curl -s -X POST $API/functions/$name -H "authorization: Bearer $tok" -H "$H" -d "$body"; }
ent() { local tok=$1 method=$2 p=$3 body=$4; if [ -n "$body" ]; then curl -s -X $method "$API/entities/$p" -H "authorization: Bearer $tok" -H "$H" -d "$body"; else curl -s -X $method "$API/entities/$p" -H "authorization: Bearer $tok"; fi; }
# Eastern helpers
TODAY=$(TZ=America/New_York date +%F)
TOMORROW=$(TZ=America/New_York date -v+1d +%F)
YESTERDAY=$(TZ=America/New_York date -v-1d +%F)
hm() { TZ=America/New_York date -v${1}M +%H:%M; }   # hm +10 -> now+10min Eastern
```

### Setup (local users, Client records, waivers; user_type set via local D1 SQL)
```sh
source ./env.sh
reg() { curl -s -X POST $API/auth/register -H "$H" -d "{\"email\":\"$1\",\"password\":\"testpass123\",\"full_name\":\"$2\",\"user_type\":\"independent\"}" | jq -r .user.id; }
C=$(reg coach.cls@example.test "Casey Coach"); M1=$(reg m1.cls@example.test "Alice Anders"); M2=$(reg m2.cls@example.test "Bob Brown"); M3=$(reg m3.cls@example.test "Cara Cole")
echo "C=$C M1=$M1 M2=$M2 M3=$M3"
sql "UPDATE users SET user_type='trainer' WHERE id='$C'; UPDATE users SET user_type='client' WHERE id IN ('$M1','$M2','$M3');"
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
sql "INSERT INTO entities (id,entity_type,data,created_by,created_date,updated_date) VALUES
('cl_m1','Client','{\"full_name\":\"Alice Anders\",\"email\":\"m1.cls@example.test\",\"user_id\":\"$M1\",\"trainer_id\":\"$C\"}','coach.cls@example.test','$NOW','$NOW'),
('cl_m2','Client','{\"full_name\":\"Bob Brown\",\"email\":\"m2.cls@example.test\",\"user_id\":\"$M2\",\"trainer_id\":\"$C\"}','coach.cls@example.test','$NOW','$NOW'),
('cl_m3','Client','{\"full_name\":\"Cara Cole\",\"email\":\"m3.cls@example.test\",\"user_id\":\"$M3\",\"trainer_id\":\"$C\"}','coach.cls@example.test','$NOW','$NOW'),
('ct_m1','Contract','{\"client_id\":\"cl_m1\",\"type\":\"waiver\",\"title\":\"Liability Waiver\",\"status\":\"signed\"}','coach.cls@example.test','$NOW','$NOW'),
('ct_m2','Contract','{\"client_id\":\"cl_m2\",\"type\":\"other\",\"title\":\"Brigade Waiver 2026\",\"status\":\"signed\"}','coach.cls@example.test','$NOW','$NOW');"
login() { curl -s -X POST $API/auth/login -H "$H" -d "{\"email\":\"$1\",\"password\":\"testpass123\"}" | jq -r .token; }
{ echo "COACH=$(login coach.cls@example.test)"; echo "T1=$(login m1.cls@example.test)"; echo "T2=$(login m2.cls@example.test)"; echo "T3=$(login m3.cls@example.test)"; echo "M1=$M1"; echo "M2=$M2"; echo "M3=$M3"; echo "CID=$C"; } > tokens.sh
cat tokens.sh | cut -c1-40
```

## 1. Library types, memberships (plan copy), one-off session
```sh
source ./env.sh; source ./tokens.sh
echo "== library (staff writes, member blocked)"
CF=$(ent $COACH POST ClassType '{"name":"CrossFit","color":"#ef4444","reservable":true,"default_capacity":2,"default_duration_min":60,"is_active":true}' | jq -r .id)
OG=$(ent $COACH POST ClassType '{"name":"Open Gym","color":"#64748b","reservable":false,"default_capacity":null,"default_duration_min":60,"is_active":true}' | jq -r .id)
echo "CF=$CF OG=$OG"
echo "member POST ClassType: $(ent $T1 POST ClassType '{"name":"x"}')"
echo "member reads ClassType: $(ent $T1 GET ClassType | jq length)"
UNL=$(ent $COACH POST MembershipPlan '{"name":"Unlimited","kind":"unlimited","class_type_ids":[],"is_active":true}' | jq -r .id)
SIL=$(ent $COACH POST MembershipPlan '{"name":"Silver 2x/week","kind":"limited","limit_count":2,"limit_period":"week","class_type_ids":[],"is_active":true}' | jq -r .id)
PUN=$(ent $COACH POST MembershipPlan '{"name":"3-Class Punch Card","kind":"punch","limit_count":3,"limit_period":"total","duration_days":90,"class_type_ids":[],"is_active":true}' | jq -r .id)
echo "== memberships (plan fields copied by backend)"
MS1=$(ent $COACH POST Membership "{\"client_id\":\"cl_m1\",\"plan_id\":\"$UNL\",\"start_date\":\"$YESTERDAY\"}" | jq -r .id)
MS2=$(ent $COACH POST Membership "{\"client_id\":\"cl_m2\",\"plan_id\":\"$SIL\",\"start_date\":\"$YESTERDAY\"}" | jq -r .id)
ent $COACH POST Membership "{\"client_id\":\"cl_m3\",\"plan_id\":\"$PUN\",\"start_date\":\"$YESTERDAY\"}" | tee /tmp/x >/dev/null; MS3=$(jq -r .id /tmp/x 2>/dev/null || true)
jq -c '{plan_name,kind,limit_count,limit_period,sessions_total,sessions_used,end_date,client_user_id,status}' /tmp/x
echo "member POST Membership: $(ent $T1 POST Membership '{"client_id":"cl_m1","plan_id":"x"}')"
echo "MS1=$MS1 MS2=$MS2 MS3=$MS3"
echo "== sessions (one-off via entity API, backend fills start_at/end_at)"
A=$(ent $COACH POST ClassSession "{\"class_type_id\":\"$CF\",\"date\":\"$TOMORROW\",\"start_time\":\"10:00\",\"duration_min\":60}" | tee /tmp/x | jq -r .id)
jq -c '{class_type_name,date,start_time,end_time,start_at,end_at,capacity,reservable,status,reserved_count}' /tmp/x
{ echo "CF=$CF"; echo "OG=$OG"; echo "UNL=$UNL"; echo "SIL=$SIL"; echo "PUN=$PUN"; echo "MS1=$MS1"; echo "MS2=$MS2"; echo "MS3=$MS3"; echo "A=$A"; } > ids.sh
```
Result:
```
member POST ClassType: {"message":"Only coaches can change this."...}   (403)
member reads ClassType: 2
Membership (punch) after POST with only client_id/plan_id/start_date(2026-11-20):
{"plan_name":"3-Class Punch Card","kind":"punch","limit_count":3,"limit_period":"total","sessions_total":3,"sessions_used":0,"end_date":"2027-02-17","client_user_id":"89fb...","status":"active"}
member POST Membership: "Only coaches can change this." (403)
One-off session: {"class_type_name":"CrossFit","date":"2026-11-22","start_time":"10:00","end_time":"11:00","start_at":"2026-11-22T15:00:00.000Z","end_at":"2026-11-22T16:00:00.000Z","capacity":2,"reservable":true,"status":"scheduled","reserved_count":0}
```

## 2. Waiver, capacity -> waitlist, cancel -> promotion + notification
```sh
source ./env.sh; source ./tokens.sh; source ./ids.sh
j='{success,status,error,code,res:.reservation|{status,waitlist_position,membership_id},counts:(.session|{reserved_count,waitlist_count,checked_in_count})}'
echo "== waiver block: m3 has no waiver"
fn $T3 bookClass "{\"session_id\":\"$A\"}" | jq -c "$j"
echo "== staff booking for m3 without waiver -> warning (then cancel it)"
R=$(fn $COACH bookClass "{\"session_id\":\"$A\",\"client_id\":\"cl_m3\"}" | tee /tmp/x | jq -r .reservation.id); jq -c '{success,warnings,status:.reservation.status}' /tmp/x
fn $COACH cancelReservation "{\"reservation_id\":\"$R\"}" | jq -c '{success,status}'
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
sql "INSERT INTO entities (id,entity_type,data,created_by,created_date,updated_date) VALUES ('ct_m3','Contract','{\"client_id\":\"cl_m3\",\"type\":\"waiver\",\"title\":\"Liability Waiver\",\"status\":\"signed\"}','coach.cls@example.test','$NOW','$NOW');"
echo "== cap 2: m1 reserved, m2 reserved, m3 waitlisted #1"
R1=$(fn $T1 bookClass "{\"session_id\":\"$A\"}" | tee /tmp/x | jq -r .reservation.id); jq -c "$j" /tmp/x
R2=$(fn $T2 bookClass "{\"session_id\":\"$A\"}" | tee /tmp/x | jq -r .reservation.id); jq -c "$j" /tmp/x
R3=$(fn $T3 bookClass "{\"session_id\":\"$A\"}" | tee /tmp/x | jq -r .reservation.id); jq -c "$j" /tmp/x
echo "== double booking refused"
fn $T1 bookClass "{\"session_id\":\"$A\"}" | jq -c "$j"
fn $T3 bookClass "{\"session_id\":\"$A\"}" | jq -c "$j"
echo "== member cannot cancel someone else's reservation"
fn $T1 cancelReservation "{\"reservation_id\":\"$R2\"}" | jq -c '{success,error}'
echo "== m1 cancels (19h before, outside late window) -> cancelled; m3 promoted + notified"
fn $T1 cancelReservation "{\"reservation_id\":\"$R1\"}" | jq -c '{success,status,late_cancel,promoted,counts:(.session|{reserved_count,waitlist_count})}'
ent $COACH GET Reservation/$R3 | jq -c '{status,waitlist_position,membership_id,promoted_at:(.promoted_at!=null)}'
ent $T3 GET "Notification?filter=$(jq -rn --arg u $M3 '{user_id:$u}|@uri')" | jq -c '[.[]|{type,title,message,link}]'
{ echo "R1=$R1"; echo "R2=$R2"; echo "R3=$R3"; } >> ids.sh
```
Result:
```
waiver block (m3): {"success":false,"error":"Sign the liability waiver before booking a class. You can find it under Documents.","code":"waiver_required"}
staff books m3 w/o waiver: {"success":true,"warnings":["No signed waiver on file."],"status":"reserved"}  -> cancelled again
m1: reserved (counts 1/0), m2: reserved (2/0), m3: waitlisted position 1 (2/1)
double booking: "You are already booked in this class." / "You are already on the waitlist for this class." (already_booked)
m1 cancels m2's reservation: {"success":false,"error":"Reservation not found."}
m1 cancels own 19h before: {"status":"cancelled","late_cancel":false,"promoted":1,"counts":{"reserved_count":2,"waitlist_count":0}}
m3 now: {"status":"reserved","waitlist_position":null,"promoted_at":true}
m3 notification: [{"type":"class","title":"You are in","message":"A spot opened in CrossFit on Sun, Nov 22 at 10:00 AM. You moved off the waitlist and are booked.","link":"/ClientClasses"}]
```

## 3. Late-cancel window (no promotion), weekly limit, booking race
```sh
source ./env.sh; source ./tokens.sh; source ./ids.sh
j='{success,status,error,code,late_cancel,promoted,res:.reservation|{status,waitlist_position},counts:(.session|{reserved_count,waitlist_count,checked_in_count})}'
mk() { ent $COACH POST ClassSession "$1" | jq -r .id; }
echo "== late-cancel window: session B today in 3h, cap 1"
B=$(mk "{\"class_type_id\":\"$CF\",\"date\":\"$TODAY\",\"start_time\":\"$(hm +180)\",\"duration_min\":60,\"capacity\":1}")
RB1=$(fn $T1 bookClass "{\"session_id\":\"$B\"}" | tee /tmp/x | jq -r .reservation.id); jq -c "$j" /tmp/x
RB3=$(fn $T3 bookClass "{\"session_id\":\"$B\"}" | tee /tmp/x | jq -r .reservation.id); jq -c "$j" /tmp/x
fn $T1 cancelReservation "{\"reservation_id\":\"$RB1\"}" | jq -c "$j"
echo "m3 still waitlisted (no promotion inside late-cancel window):"; ent $COACH GET Reservation/$RB3 | jq -c '{status,waitlist_position}'
echo "== waitlisted cancel is plain cancelled even inside window"
fn $T3 cancelReservation "{\"reservation_id\":\"$RB3\"}" | jq -c "$j"
echo "== weekly limit (m2 Silver 2/week; already reserved in A tomorrow, same Mon-Sun week)"
A2=$(mk "{\"class_type_id\":\"$CF\",\"date\":\"$TOMORROW\",\"start_time\":\"12:00\",\"duration_min\":60,\"capacity\":10}")
A3=$(mk "{\"class_type_id\":\"$CF\",\"date\":\"$TOMORROW\",\"start_time\":\"14:00\",\"duration_min\":60,\"capacity\":10}")
RA2=$(fn $T2 bookClass "{\"session_id\":\"$A2\"}" | tee /tmp/x | jq -r .reservation.id); jq -c "$j" /tmp/x
fn $T2 bookClass "{\"session_id\":\"$A3\"}" | jq -c "$j"
echo "next week is a new week:"
NW=$(mk "{\"class_type_id\":\"$CF\",\"date\":\"$(TZ=America/New_York date -v+2d +%F)\",\"start_time\":\"12:00\",\"duration_min\":60,\"capacity\":10}")
RNW=$(fn $T2 bookClass "{\"session_id\":\"$NW\"}" | tee /tmp/x | jq -r .reservation.id); jq -c "$j" /tmp/x
echo "cancel A2 -> allowance back, A3 books:"
fn $T2 cancelReservation "{\"reservation_id\":\"$RA2\"}" | jq -c '{success,status}'
fn $T2 bookClass "{\"session_id\":\"$A3\"}" | jq -c "$j"
echo "== race: cap 1, m1 and m2 book in parallel"
RC=$(mk "{\"class_type_id\":\"$CF\",\"date\":\"$(TZ=America/New_York date -v+3d +%F)\",\"start_time\":\"09:00\",\"duration_min\":60,\"capacity\":1}")
fn $T1 bookClass "{\"session_id\":\"$RC\"}" > /tmp/r1 & fn $T2 bookClass "{\"session_id\":\"$RC\"}" > /tmp/r2 & fn $T1 bookClass "{\"session_id\":\"$RC\"}" > /tmp/r3 & wait
for f in /tmp/r1 /tmp/r2 /tmp/r3; do jq -c '{success,status,error}' $f; done
ent $COACH GET ClassSession/$RC | jq -c '{capacity,reserved_count,waitlist_count}'
{ echo "B=$B"; echo "A2=$A2"; echo "A3=$A3"; echo "NW=$NW"; echo "RC=$RC"; } >> ids.sh
```
Result:
```
B (3h out, cap 1): m1 reserved; m3 waitlisted #1
m1 cancels inside 8h window: {"status":"late_cancelled","late_cancel":true,"promoted":0,"counts":{"reserved_count":0,"waitlist_count":1}}
m3 still: {"status":"waitlisted","waitlist_position":1}      <- no auto-promotion inside the late-cancel window
m3 leaves waitlist inside window: {"status":"cancelled","late_cancel":false}
Weekly limit: m2 books A2 -> reserved (2 of 2 this week); A3 -> {"success":false,"error":"You have used all 2 classes on your plan for that week.","code":"limit_reached"}
next week (Mon) -> reserved; cancel A2 -> A3 now books (reserved)
Race (cap 1; m1, m2, m1 in parallel):
  {"success":false,"error":"You are already booked in this class."}
  {"success":true,"status":"waitlisted"}
  {"success":true,"status":"reserved"}
  session: {"capacity":1,"reserved_count":1,"waitlist_count":1}
```

## 4. Check-in window, punch card +/- and undo, book+check-in, open gym, walk-in override, no-show convert, cancel class
```sh
source ./env.sh; source ./tokens.sh; source ./ids.sh
j='{success,already,error,code,warnings,res:.reservation|{status,check_in_method,punch_applied,created_at_checkin},counts:(.session|{reserved_count,checked_in_count})}'
mk() { ent $COACH POST ClassSession "$1" | jq -r .id; }
used() { ent $COACH GET Membership/$MS3 | jq -c '{sessions_used}'; }
echo "== self check-in window: session D in 3h, m1 booked -> too early"
D=$(mk "{\"class_type_id\":\"$CF\",\"date\":\"$TODAY\",\"start_time\":\"$(hm +180)\",\"duration_min\":60,\"capacity\":10}")
fn $T1 bookClass "{\"session_id\":\"$D\"}" | jq -c '{success,status}'
fn $T1 checkIn "{\"session_id\":\"$D\"}" | jq -c "$j"
echo "== session C starts in 10 min (check-in open, booking closed)"
C=$(mk "{\"class_type_id\":\"$CF\",\"date\":\"$TODAY\",\"start_time\":\"$(hm +10)\",\"duration_min\":60,\"capacity\":10}")
fn $T3 bookClass "{\"session_id\":\"$C\"}" | jq -c '{success,error,code}'
echo "staff books m3 (staff bypasses windows):"
RC3=$(fn $COACH bookClass "{\"session_id\":\"$C\",\"client_id\":\"cl_m3\"}" | tee /tmp/x | jq -r .reservation.id); jq -c '{success,status}' /tmp/x
echo "punch before: $(used)"
echo "m3 self check-in (punch card) -> checked_in, sessions_used +1:"
fn $T3 checkIn "{\"session_id\":\"$C\"}" | jq -c "$j"; used
echo "check in again is idempotent (no double punch):"
fn $T3 checkIn "{\"session_id\":\"$C\"}" | jq -c '{success,already}'; used
echo "member cannot undo:"; fn $T3 undoCheckIn "{\"reservation_id\":\"$RC3\"}" | jq -c '{success,error}'
echo "staff undo -> back to reserved, punch restored:"
fn $COACH undoCheckIn "{\"reservation_id\":\"$RC3\"}" | jq -c "$j"; used
echo "== book-and-check-in in one step: m1 has no reservation in C"
fn $T1 checkIn "{\"session_id\":\"$C\"}" | jq -c "$j"
echo "== staff undo of a reservation created at check-in -> cancelled (fallback lookup by session_id+client_id)"
fn $COACH undoCheckIn "{\"session_id\":\"$C\",\"client_id\":\"cl_m1\"}" | jq -c "$j"
echo "== open gym E: started 10 min ago, ends in 50"
E=$(mk "{\"class_type_id\":\"$OG\",\"date\":\"$TODAY\",\"start_time\":\"$(hm -10)\",\"duration_min\":60}")
ent $COACH GET ClassSession/$E | jq -c '{reservable,capacity}'
fn $T1 bookClass "{\"session_id\":\"$E\"}" | jq -c '{success,error,code}'
fn $T1 checkIn "{\"session_id\":\"$E\"}" | jq -c "$j"
echo "== staff walk-in: m2 at open gym; m2 has used 2/2 this week -> needs override"
fn $COACH checkIn "{\"session_id\":\"$E\",\"client_id\":\"cl_m2\"}" | jq -c '{success,error,code,can_override}'
fn $COACH checkIn "{\"session_id\":\"$E\",\"client_id\":\"cl_m2\",\"override\":true}" | jq -c "$j + {override:.reservation.membership_override}"
echo "== markNoShow / convert back (staff), on m1 at E (started)"
RE1=$(ent $COACH GET "Reservation?filter=$(jq -rn --arg s $E '{session_id:$s,client_id:"cl_m1"}|@uri')" | jq -r '.[0].id')
fn $COACH markNoShow "{\"reservation_id\":\"$RE1\"}" | jq -c "$j"
fn $COACH checkIn "{\"session_id\":\"$E\",\"client_id\":\"cl_m1\",\"reservation_id\":\"$RE1\"}" | jq -c "$j"
echo "markNoShow before start refused (D in 3h):"
RD1=$(ent $COACH GET "Reservation?filter=$(jq -rn --arg s $D '{session_id:$s,client_id:"cl_m1"}|@uri')" | jq -r '.[0].id')
fn $COACH markNoShow "{\"reservation_id\":\"$RD1\"}" | jq -c '{success,error}'
echo "== cancel class C with m3 checked in on a punch card -> cancelled_by_gym, punch restored, notified"
fn $T3 checkIn "{\"session_id\":\"$C\"}" | jq -c '{success,status:.reservation.status}'; used
fn $T1 cancelClassSession "{\"session_id\":\"$C\",\"reason\":\"x\"}" | jq -c '{success,error}'
fn $COACH cancelClassSession "{\"session_id\":\"$C\",\"reason\":\"Coach out sick\"}" | jq -c '{success,affected,notified,session:(.session|{status,cancel_reason,reserved_count,checked_in_count})}'
ent $COACH GET Reservation/$RC3 | jq -c '{status}'; used
ent $T3 GET "Notification?filter=$(jq -rn --arg u $M3 '{user_id:$u}|@uri')" | jq -c '[.[]|.title+": "+.message]'
fn $T1 bookClass "{\"session_id\":\"$C\"}" | jq -c '{success,error}'
{ echo "C=$C"; echo "D=$D"; echo "E=$E"; } >> ids.sh
```
Result:
```
D in 3h, m1 booked, self check-in: {"error":"Check-in opens 30 minutes before class.","code":"checkin_not_open"}
C in 10 min, m3 books: {"error":"Booking for this class has closed.","code":"booking_closed"}; staff books m3: reserved
punch before {"sessions_used":0}; m3 self check-in -> checked_in, method self, punch_applied true; {"sessions_used":1}
check in again: {"success":true,"already":true}; still {"sessions_used":1}
member undo: "Only coaches can change attendance."
staff undo -> {"status":"reserved","punch_applied":false}, counts {reserved 1, checked_in 0}; {"sessions_used":0}
m1 (no reservation) self check-in in window -> checked_in, created_at_checkin true (book + check in in one step)
staff undo via {session_id, client_id} -> "cancelled" (created at check-in)
Open gym E (started 10 min ago): reservable false, capacity null
  m1 bookClass -> {"error":"This class does not take reservations. Check in when you arrive.","code":"not_reservable"}
  m1 checkIn -> checked_in, method self
Staff walk-in m2 at E (weekly limit used): {"success":false,"error":"You have used all 2 classes ...","code":"limit_reached","can_override":true}
  (wording for staff was then changed to "This client has used all ..."; re-verified not re-run)
  with override:true -> checked_in, method walk_in, membership_override true, warnings ["Checked in without a covering membership (staff override)."]
markNoShow m1 at E -> no_show, counts drop (reserved 1, checked_in 1); checkIn with reservation_id -> checked_in again (method coach), counts restored (2/2)
markNoShow on D (not started): "You can mark a no-show once the class has started."
Cancel class C with m3 checked in on punch card (sessions_used 1):
  member cancelClassSession: "Only coaches can cancel a class."
  staff: {"success":true,"affected":1,"notified":1,"session":{"status":"cancelled","cancel_reason":"Coach out sick","reserved_count":0,"checked_in_count":0}}
  m3 reservation -> cancelled_by_gym; {"sessions_used":0}
  m3 notification: "Class cancelled: CrossFit on Sat, Nov 21 at 3:05 PM was cancelled: Coach out sick"
  booking a cancelled class: "This class was cancelled."
```

## 5. Punch total limit, classTick no-shows + waitlist expiry, cron route
```sh
source ./env.sh; source ./tokens.sh; source ./ids.sh
mk() { ent $COACH POST ClassSession "$1" | jq -r .id; }
echo "== punch card total limit (m3: 3 total, 1 reserved in A)"
fn $T3 bookClass "{\"session_id\":\"$A2\"}" | jq -c '{success,status}'
fn $T3 bookClass "{\"session_id\":\"$A3\"}" | jq -c '{success,status}'
fn $T3 bookClass "{\"session_id\":\"$NW\"}" | jq -c '{success,error,code}'
echo "== classTick: no-show marking + waitlist expiry (session F yesterday 08:00, ended > 2h ago)"
F=$(mk "{\"class_type_id\":\"$CF\",\"date\":\"$YESTERDAY\",\"start_time\":\"08:00\",\"duration_min\":60,\"capacity\":1}")
ent $COACH POST Reservation "{\"session_id\":\"$F\",\"class_type_id\":\"$CF\",\"date\":\"$YESTERDAY\",\"client_id\":\"cl_m1\",\"client_user_id\":\"$M1\",\"client_name\":\"Alice Anders\",\"status\":\"reserved\",\"membership_id\":\"$MS1\",\"booked_at\":\"2026-11-19T00:00:00.000Z\"}" | jq -c '{id,status}'
ent $COACH POST Reservation "{\"session_id\":\"$F\",\"class_type_id\":\"$CF\",\"date\":\"$YESTERDAY\",\"client_id\":\"cl_m2\",\"client_user_id\":\"$M2\",\"client_name\":\"Bob Brown\",\"status\":\"waitlisted\",\"waitlist_position\":1,\"membership_id\":\"$MS2\",\"booked_at\":\"2026-11-19T00:00:00.000Z\"}" | jq -c '{id,status}'
echo "counts after staff direct writes (hook recount):"; ent $COACH GET ClassSession/$F | jq -c '{reserved_count,waitlist_count}'
fn $T1 classTick | jq -c '{success,error}'
fn $COACH classTick | jq -c .
ent $COACH GET "Reservation?filter=$(jq -rn --arg s $F '{session_id:$s}|@uri')" | jq -c '[.[]|{client_name,status,auto_no_show,waitlist_expired}]'
ent $COACH GET ClassSession/$F | jq -c '{reserved_count,waitlist_count}'
echo "second tick marks nothing new:"; fn $COACH classTick | jq -c '{no_shows,waitlist_expired,generated}'
echo "== cron route (x-cron-secret) runs program tick then class tick"
CS=$(grep '^CRON_SECRET=' $REPO/.dev.vars | cut -d= -f2-)
curl -s -X POST $API/cron/program-tick -H "x-cron-secret: $CS" -H "$H" -d '{}' | jq -c '{success,enrollments,classes:(.classes|{success,generated,no_shows})}'
curl -s -X POST $API/cron/program-tick -H "x-cron-secret: wrong" -H "$H" -d '{}' | jq -c .
echo "F=$F" >> ids.sh
```
Result:
```
punch (3 total, 1 reserved): A2 reserved, A3 reserved, NW -> {"error":"No classes left on your plan.","code":"limit_reached"}
F (yesterday 08:00-09:00): staff-written reserved (m1) + waitlisted (m2); hook recount -> {"reserved_count":1,"waitlist_count":1}
member classTick: "Only coaches can run this."
staff classTick: {"success":true,"generated":0,...,"no_shows":1,"waitlist_expired":1}
F reservations: m2 cancelled (waitlist_expired), m1 no_show (auto_no_show); F counts 0/0
second tick: {"no_shows":0,"waitlist_expired":0,"generated":0}
cron with secret: {"success":true,"enrollments":1,"classes":{"success":true,"generated":0,"no_shows":0}}
cron wrong secret: 401 Unauthorized.
```

## 6. Slot generation idempotency and slot edit/deactivate sync
```sh
source ./env.sh; source ./tokens.sh; source ./ids.sh
DOW=$(TZ=America/New_York date -v+1d +%w)
cnt() { ent $COACH GET "ClassSession?filter=$(jq -rn --arg s $1 '{slot_id:$s}|@uri')" | jq -c '[.[]|select(.status=="scheduled")]|{scheduled:length,times:([.[].start_time]|unique),caps:([.[].capacity]|unique),coach:([.[].coach_name]|unique)}'; }
echo "== slot for weekday $DOW (tomorrow) at 06:00 -> POST generates 3 sessions in a 21-day horizon"
SL=$(ent $COACH POST ClassSlot "{\"class_type_id\":\"$CF\",\"day_of_week\":$DOW,\"start_time\":\"06:00\",\"duration_min\":60,\"capacity\":null,\"coach_user_id\":\"$CID\",\"coach_name\":\"Casey Coach\",\"start_date\":\"$TODAY\",\"is_active\":true}" | tee /tmp/x | jq -r .id)
jq -c '.class_sync' /tmp/x
cnt $SL
echo "classTick twice -> generated 0 (idempotent):"
fn $COACH classTick | jq -c '{generated,updated}'; fn $COACH classTick | jq -c '{generated,updated}'
ent $COACH GET "ClassSession?filter=$(jq -rn --arg s $SL '{slot_id:$s}|@uri')" | jq -c '[.[].id]|{total:length,unique:(unique|length)}'
echo "parallel classTick x3 still no duplicates:"
for i in 1 2 3; do fn $COACH classTick > /tmp/ct$i & done; wait
ent $COACH GET "ClassSession?filter=$(jq -rn --arg s $SL '{slot_id:$s}|@uri')" | jq -c '[.[]|.date]|{total:length,unique:(unique|length)}'
FIRST=$(ent $COACH GET "ClassSession?filter=$(jq -rn --arg s $SL '{slot_id:$s}|@uri')&sort=date" | jq -r '.[0].id')
echo "== m1 books the first generated session ($FIRST)"
fn $T1 bookClass "{\"session_id\":\"$FIRST\"}" | jq -c '{success,status}'
echo "== edit slot: 07:30, cap 12, new coach name -> empty sessions follow; booked one keeps time/cap"
ent $COACH PUT ClassSlot/$SL '{"start_time":"07:30","capacity":12,"coach_name":"Dana Coach"}' | jq -c '.class_sync|{updated,booked_kept,booked_sessions}'
ent $COACH GET ClassSession/$FIRST | jq -c '{start_time,capacity,coach_name}'
cnt $SL
echo "== UI flow: entity PUT then classTick also converges (no further changes)"
fn $COACH classTick | jq -c '{generated,updated,cancelled,booked_kept}'
echo "== deactivate slot -> empty future sessions cancelled (hidden from schedule), booked one kept and reported"
ent $COACH PUT ClassSlot/$SL '{"is_active":false}' | jq -c '.class_sync|{cancelled,booked_kept,booked_sessions}'
cnt $SL
echo "reactivate -> revived:"
ent $COACH PUT ClassSlot/$SL '{"is_active":true}' | jq -c '.class_sync|{revived,generated,booked_kept}'
cnt $SL
echo "== single-session edit by staff (time) is kept even when the slot changes later"
SECOND=$(ent $COACH GET "ClassSession?filter=$(jq -rn --arg s $SL '{slot_id:$s}|@uri')&sort=date" | jq -r '.[1].id')
ent $COACH PUT ClassSession/$SECOND '{"start_time":"09:15"}' | jq -c '{start_time,end_time,start_at,edited_manually}'
ent $COACH PUT ClassSlot/$SL '{"start_time":"08:00"}' | jq -c '.class_sync|{updated}'
ent $COACH GET ClassSession/$SECOND | jq -c '{start_time}'
echo "SL=$SL" >> ids.sh; echo "FIRST=$FIRST" >> ids.sh
```
Result:
```
POST slot (Sun 06:00): class_sync {"generated":3,...}; 3 scheduled sessions, cap 2 (type default), coach Casey Coach
classTick x2 -> generated 0, updated 0; ids total 3 unique 3; 3 parallel classTicks -> still 3 sessions, 3 unique dates
m1 books first generated session
PUT slot 07:30 / cap 12 / coach Dana: {"updated":2,"booked_kept":1,"booked_sessions":[{"id":"cs_..._2026-11-22","date":"2026-11-22","start_time":"06:00","reserved_count":1}]}
  booked session: {"start_time":"06:00","capacity":2,"coach_name":"Dana Coach"}  (time/cap kept, coach follows)
  empty sessions: 07:30, cap 12
classTick afterwards: {"generated":0,"updated":0,"cancelled":0,"booked_kept":1}
deactivate: {"cancelled":2,"booked_kept":1,...}; only the booked one stays scheduled
reactivate: {"revived":2,"generated":0,"booked_kept":1}
single-session edit then slot edit: the edited session keeps its time (edited_manually)
  BUG FOUND here: start_time-only edit computed end_time from the old end_time (gave 08:30). Fixed; see t7 re-test.
```

## 7. Single-session edits, capacity raise promotion, permissions, read shapes
```sh
source ./env.sh; source ./tokens.sh; source ./ids.sh
echo "== single-session edit: start_time only keeps duration; end_time explicit sets duration"
ent $COACH PUT ClassSession/$A3 '{"start_time":"14:30"}' | jq -c '{start_time,end_time,duration_min,start_at,end_at,edited_manually}'
ent $COACH PUT ClassSession/$A3 '{"end_time":"16:00"}' | jq -c '{start_time,end_time,duration_min}'
echo "== capacity raise on a single session promotes the waitlist (RC: cap 1, 1 waitlisted, 3 days out)"
ent $COACH PUT ClassSession/$RC '{"capacity":2}' | jq -c '{capacity,reserved_count,waitlist_count,class_sync}'
echo "== staff sets status cancelled via entity PUT -> reservations cancelled_by_gym too"
ent $COACH PUT ClassSession/$D '{"status":"cancelled","cancel_reason":"Holiday"}' | jq -c '{status,reserved_count,class_sync}'
echo "== permissions"
RID=$(ent $COACH GET "Reservation?filter=$(jq -rn --arg s $A '{session_id:$s,client_id:"cl_m2"}|@uri')" | jq -r '.[0].id')
echo "m1 POST Reservation: $(ent $T1 POST Reservation "{\"session_id\":\"$A\",\"client_id\":\"cl_m1\",\"status\":\"reserved\"}" | jq -c .message)"
echo "m1 PUT own reservation: $(ent $T1 PUT Reservation/$R1 '{"status":"reserved"}' | jq -c .message)"
echo "m1 GET m2 reservation: $(ent $T1 GET Reservation/$RID | jq -c .message)"
echo "m1 DELETE m2 reservation: $(ent $T1 DELETE Reservation/$RID | jq -c .message)"
echo "m1 list Reservation (client_ids seen): $(ent $T1 GET Reservation | jq -c '[.[].client_id]|unique')"
echo "m1 list filtered to m2: $(ent $T1 GET "Reservation?filter=$(jq -rn '{client_id:"cl_m2"}|@uri')" | jq length)"
echo "m1 list Membership: $(ent $T1 GET Membership | jq -c '[.[].client_id]')"
echo "m1 classRoster: $(fn $T1 classRoster "{\"session_id\":\"$A\"}" | jq -c .error)"
echo "m1 classMemberStatus: $(fn $T1 classMemberStatus '{"client_id":"cl_m2"}' | jq -c .error)"
echo "m1 bookClass with client_id of m2: $(fn $T1 bookClass "{\"session_id\":\"$A2\",\"client_id\":\"cl_m2\"}" | jq -c .error)"
echo "m1 PUT ClassSession: $(ent $T1 PUT ClassSession/$A '{"capacity":99}' | jq -c .message)"
echo "staff list Reservation count: $(ent $COACH GET Reservation | jq length)"
echo "== classSchedule (member m1): my_reservation + short attendee names"
fn $T1 classSchedule "{\"from\":\"$TOMORROW\",\"to\":\"$TOMORROW\"}" | jq -c '{success,from,to,n:(.sessions|length),settings_waiver:.settings.waiver_required,sessions:[.sessions[]|{class_type_name,start_time,capacity,reserved_count,spots_left,is_full,my_reservation,attendees}]}'
echo "== classSchedule (staff): no my_reservation/attendees, has windows"
fn $COACH classSchedule "{\"from\":\"$TOMORROW\",\"to\":\"$TOMORROW\"}" | jq -c '[.sessions[]|{start_time,has_my:has("my_reservation"),has_att:has("attendees"),windows}][0]'
echo "== classRoster (staff)"
fn $COACH classRoster "{\"session_id\":\"$A\"}" | jq -c '{success,reservations:[.reservations[]|{id:(.id!=null),client_id,client_name,status,waitlist_position,check_in_method,membership_name,waiver_signed}]}'
echo "== myClasses (m3)"
fn $T3 myClasses | jq -c '{success,client,upcoming:[.upcoming[]|{class_name,date,start_time,end_at:(.end_at!=null),status,color,overrides}],recent:[.recent[]|{class_name,status}],memberships:[.memberships[]|{plan_name,kind,allowance,remaining}],waiver,stats}'
echo "== myClasses (m2, weekly plan)"
fn $T2 myClasses | jq -c '{memberships:[.memberships[]|{plan_name,allowance,used_this_week,used_this_month}],waiver}'
echo "== classMemberStatus (staff, m3)"
fn $COACH classMemberStatus '{"client_id":"cl_m3"}' | jq -c '{success,memberships:[.memberships[]|{plan_name,sessions_used,used_this_week,used_this_month,remaining,allowance}],recent_attendance:(.recent_attendance|length),all_memberships:(.all_memberships|length),waiver}'
echo "== classCoaches (staff picker)"
fn $COACH classCoaches | jq -c '{success,n:(.coaches|length),sample:.coaches[0]|keys}'
fn $T1 classCoaches | jq -c '{success,error}'
```
Result:
```
start_time-only edit (after fix): {"start_time":"14:30","end_time":"15:30","duration_min":60,"start_at":"2026-11-22T19:30:00.000Z","end_at":"2026-11-22T20:30:00.000Z","edited_manually":true}
explicit end_time: {"start_time":"14:30","end_time":"16:00","duration_min":90}
capacity 1 -> 2 on RC (1 waitlisted): {"capacity":2,"reserved_count":2,"waitlist_count":0,"class_sync":{"promoted":1}}
PUT status cancelled on D: {"status":"cancelled","reserved_count":0,"class_sync":{"cancelled_reservations":1}}
Permissions:
  m1 POST Reservation: "Only coaches can change this." (403)   [re-run in t8 with a clean body]
  m1 PUT own reservation: "Only coaches can change this." (403)
  m1 GET m2's reservation: "Not found." (404); DELETE: "Not found." (404)
  m1 list Reservation -> client_ids ["cl_m1"] only; filtered to cl_m2 -> 0 rows
  m1 list Membership -> ["cl_m1"]
  m1 classRoster / classMemberStatus: "Only coaches can ..."
  m1 bookClass with m2's client_id: "You can only book classes for yourself."   [t8]
  m1 PUT ClassSession: "Only coaches can change this."
  staff list Reservation: 21 rows (all)
classSchedule (m1, tomorrow): 4 sessions; e.g.
  {"start_time":"06:00","capacity":2,"reserved_count":1,"spots_left":1,"is_full":false,"my_reservation":{"id":"2b3c...","status":"reserved","waitlist_position":null},"attendees":[{"name":"Alice A."}]}
  {"start_time":"10:00","reserved_count":2,"spots_left":0,"is_full":true,"my_reservation":{"status":"cancelled",...},"attendees":[{"name":"Bob B."},{"name":"Cara C."}]}
classSchedule (staff): no my_reservation / attendees keys; windows present
classRoster (staff, A): 4 rows with id, client_id, client_name, status, waitlist_position, check_in_method, membership_name, waiver_signed
myClasses (m3): upcoming 3 reserved (with start_time, end_at, color, overrides); memberships [{"plan_name":"3-Class Punch Card","allowance":{"period":"total","limit":3,"used":3,"checked_in":0,"reserved":3,"remaining":0},"remaining":0}]; waiver {"required":true,"signed":true,"contract_id":"ct_m3"}
myClasses (m2): {"allowance":{"period":"week","limit":2,"used":2,"remaining":0,"period_start":"2026-11-16","period_end":"2026-11-22"},"used_this_week":2,"used_this_month":4}
classMemberStatus (staff, m3): memberships with sessions_used, used_this_week, used_this_month, remaining, allowance; all_memberships 1; waiver signed
classCoaches: staff -> 3 coaches [email, full_name, id]; member -> "Only coaches can see this."
```

## 8. Re-run of two permission checks (shell quoting in t7)
```sh
source ./env.sh; source ./tokens.sh; source ./ids.sh
BODY1='{"session_id":"'$A'","client_id":"cl_m1","status":"reserved"}'
printf 'm1 POST Reservation: '; ent $T1 POST Reservation "$BODY1" | jq -c .message
BODY2='{"session_id":"'$A2'","client_id":"cl_m2"}'
printf 'm1 bookClass with client_id of m2: '; fn $T1 bookClass "$BODY2" | jq -c .error
```
Result:
```
m1 POST Reservation: "Only coaches can change this."
m1 bookClass with client_id of m2: "You can only book classes for yourself."
```

## Not covered / open issues
- Self check-in after the window closes (`checkin_closed`) and booking before the window opens (`booking_not_open`)
  were not exercised live (same code path as the tested `checkin_not_open` / `booking_closed`).
- Push delivery itself is not verifiable locally (no subscribed device); the Notification rows were verified.
- No index on `json_extract(data,'$.session_id')`; reservation queries scan Reservation rows by entity_type index.
  Fine at gym scale; add an expression index later if needed (schema change, so left out).
- Month allowance uses the billing month anchored on the membership start day (e.g. start 1/31 -> periods end on the
  last day of shorter months).
