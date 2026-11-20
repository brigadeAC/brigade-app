# Programs backend: curl test script

Exercises every Programs endpoint and permission rule in `functions/api/[[path]].js`
against a local server (`npx wrangler pages dev` on http://localhost:8788).

## Setup

```sh
API=http://localhost:8788/api
COACH=<bearer token of a trainer or admin>
CLIENT=<bearer token of a client login that has a Client record>
OTHER=<bearer token of a different client login>
CLIENT_ID=<Client record id for $CLIENT (entities/Client)>
CRON_SECRET=<value of CRON_SECRET in .dev.vars>
H='content-type: application/json'
```

Tokens come from `POST $API/auth/login` (`{"email","password"}` -> `token`).
Put `CRON_SECRET=...` in `.dev.vars` for the local cron route.

## 1. Library types (Lesson, Program, ProgramItem): everyone reads, staff writes

```sh
# Coach creates a lesson, a program and items
LESSON=$(curl -s -X POST $API/entities/Lesson -H "authorization: Bearer $COACH" -H "$H" \
  -d '{"title":"Protein at breakfast","category":"nutrition","tips":["Eggs count"],"reflection_question":"What will you eat tomorrow?"}' | jq -r .id)

PROGRAM=$(curl -s -X POST $API/entities/Program -H "authorization: Bearer $COACH" -H "$H" \
  -d '{"name":"4 Week Reset","duration_weeks":4,"status":"published","kind":"program"}' | jq -r .id)

TODAY=$(TZ=America/New_York date +%F)
NOW_HM=$(TZ=America/New_York date -v-5M +%H:%M 2>/dev/null || TZ=America/New_York date -d '-5 min' +%H:%M)

curl -s -X POST $API/entities/ProgramItem -H "authorization: Bearer $COACH" -H "$H" -d "[
  {\"program_id\":\"$PROGRAM\",\"day\":1,\"type\":\"lesson\",\"lesson_id\":\"$LESSON\",\"sort\":0},
  {\"program_id\":\"$PROGRAM\",\"day\":1,\"type\":\"habit\",\"name\":\"Protein at breakfast\",\"icon\":\"🍳\",\"category\":\"nutrition\",\"tracking\":\"check\",\"frequency\":\"daily\",\"end_day\":7,\"days_of_week\":[1,2,3,4,5],\"sort\":1},
  {\"program_id\":\"$PROGRAM\",\"day\":1,\"type\":\"message\",\"text\":\"How did breakfast go today?\",\"send_time\":\"$NOW_HM\",\"sort\":2},
  {\"program_id\":\"$PROGRAM\",\"day\":2,\"type\":\"workout\",\"workout_plan_id\":\"<plan id>\",\"workout_day\":1,\"title\":\"Day 1 strength\"},
  {\"program_id\":\"$PROGRAM\",\"day\":7,\"type\":\"checkin\",\"title\":\"Week 1 check-in\",\"fields\":[\"weight\",\"rating\",\"note\"]}
]" | jq '.[].id'

# Client can read them
curl -s "$API/entities/ProgramItem?filter=$(jq -rn --arg p $PROGRAM '{program_id:$p}|@uri')" \
  -H "authorization: Bearer $CLIENT" | jq length          # 5

# Client cannot write them (expect 403 "Only coaches can change this.")
curl -s -X POST $API/entities/Lesson -H "authorization: Bearer $CLIENT" -H "$H" -d '{"title":"x"}'
curl -s -X PUT  $API/entities/Program/$PROGRAM -H "authorization: Bearer $CLIENT" -H "$H" -d '{"name":"x"}'
curl -s -X DELETE $API/entities/Lesson/$LESSON -H "authorization: Bearer $CLIENT"
```

## 2. enrollInProgram (staff only)

```sh
# Client tries: expect {"success":false,"error":"Only coaches can enroll clients."}
curl -s -X POST $API/functions/enrollInProgram -H "authorization: Bearer $CLIENT" -H "$H" \
  -d "{\"program_id\":\"$PROGRAM\",\"client_id\":\"$CLIENT_ID\",\"start_date\":\"$TODAY\"}"

# Coach enrolls
ENR=$(curl -s -X POST $API/functions/enrollInProgram -H "authorization: Bearer $COACH" -H "$H" \
  -d "{\"program_id\":\"$PROGRAM\",\"client_id\":\"$CLIENT_ID\",\"start_date\":\"$TODAY\"}" | tee /dev/stderr | jq -r .enrollment.id)

# Enrolling again while active: expect success:false "... is already in 4 Week Reset."
curl -s -X POST $API/functions/enrollInProgram -H "authorization: Bearer $COACH" -H "$H" \
  -d "{\"program_id\":\"$PROGRAM\",\"client_id\":\"$CLIENT_ID\",\"start_date\":\"$TODAY\"}"

# A program Habit was created with start/end dates and days_of_week
curl -s "$API/entities/Habit?filter=$(jq -rn --arg e $ENR '{enrollment_id:$e}|@uri')" \
  -H "authorization: Bearer $COACH" | jq '.[] | {id,name,start_date,end_date,days_of_week,is_active,item_id}'
```

## 3. ProgramEnrollment / ProgramMessageLog: members read own, can't write

```sh
curl -s $API/entities/ProgramEnrollment/$ENR -H "authorization: Bearer $CLIENT" | jq .status   # "active"
curl -s $API/entities/ProgramEnrollment/$ENR -H "authorization: Bearer $OTHER"                # 404
curl -s -X PUT $API/entities/ProgramEnrollment/$ENR -H "authorization: Bearer $CLIENT" -H "$H" \
  -d '{"status":"cancelled"}'                                                                   # 403
curl -s -X POST $API/entities/ProgramEnrollment -H "authorization: Bearer $CLIENT" -H "$H" \
  -d "{\"program_id\":\"$PROGRAM\",\"client_id\":\"$CLIENT_ID\"}"                               # 403
curl -s -X POST $API/entities/ProgramMessageLog -H "authorization: Bearer $CLIENT" -H "$H" \
  -d "{\"enrollment_id\":\"$ENR\",\"item_id\":\"fake\",\"status\":\"sent\"}"                    # 403
```

## 4. Message delivery

```sh
# Cron route: no / wrong secret -> 401
curl -s -X POST $API/cron/program-tick
curl -s -X POST $API/cron/program-tick -H 'x-cron-secret: wrong'

# Correct secret -> {"success":true,"enrollments":N,"sent":1,"skipped":0,"failed":0}
curl -s -X POST $API/cron/program-tick -H "x-cron-secret: $CRON_SECRET"

# Run it again: sent 0 (idempotent; the log row already exists)
curl -s -X POST $API/cron/program-tick -H "x-cron-secret: $CRON_SECRET"

# Race check: fire 5 in parallel; total "sent" across them must be <= 1 per due item
for i in 1 2 3 4 5; do curl -s -X POST $API/cron/program-tick -H "x-cron-secret: $CRON_SECRET" & done; wait

# The client sees the message from their coach + a Notification
curl -s "$API/entities/Message?filter=$(jq -rn --arg e $ENR '{enrollment_id:$e}|@uri')" \
  -H "authorization: Bearer $CLIENT" | jq '.[] | {conversation_id,sender_name,receiver_id,content,read}'
curl -s "$API/entities/ProgramMessageLog?filter=$(jq -rn --arg e $ENR '{enrollment_id:$e}|@uri')" \
  -H "authorization: Bearer $CLIENT" | jq '.[] | {item_id,status,reason,scheduled_for,sent_at,message_id}'

# Lazy tick: any signed-in user. Client ticks only their own active enrollments; staff tick all
# (or one with {"enrollment_id": ...}).
curl -s -X POST $API/functions/programTick -H "authorization: Bearer $CLIENT" -H "$H" -d '{}'
curl -s -X POST $API/functions/programTick -H "authorization: Bearer $COACH"  -H "$H" -d "{\"enrollment_id\":\"$ENR\"}"
```

Backlog rule: enroll another client with `start_date` 10 days ago and tick. Messages
whose time is more than 3 days past get a log row with `status:"skipped", reason:"too_old"`
and are never sent. A client with no login gets `reason:"no_login"`.

## 5. programCalendar

```sh
curl -s -X POST $API/functions/programCalendar -H "authorization: Bearer $COACH" -H "$H" \
  -d "{\"enrollment_id\":\"$ENR\",\"from\":\"$TODAY\",\"to\":\"$(TZ=America/New_York date -v+13d +%F 2>/dev/null || date -d '+13 days' +%F)\"}" \
  | jq '{today, today_day, days: [.days[] | {date, day, items: [.items[] | {type,title,status}]}]}'

# Client can read their own; another client gets "Enrollment not found."
curl -s -X POST $API/functions/programCalendar -H "authorization: Bearer $CLIENT" -H "$H" -d "{\"enrollment_id\":\"$ENR\"}" | jq '.days | length'  # 28
curl -s -X POST $API/functions/programCalendar -H "authorization: Bearer $OTHER"  -H "$H" -d "{\"enrollment_id\":\"$ENR\"}"
```

## 6. updateEnrollment (skip / move / extra items / status) and habit re-sync

```sh
ITEMS=$(curl -s "$API/entities/ProgramItem?filter=$(jq -rn --arg p $PROGRAM '{program_id:$p}|@uri')" -H "authorization: Bearer $COACH")
HABIT_ITEM=$(echo "$ITEMS" | jq -r '.[] | select(.type=="habit") | .id')
CHECKIN_ITEM=$(echo "$ITEMS" | jq -r '.[] | select(.type=="checkin") | .id')

# Move the habit to day 3 (keeps its 7-day length), skip the check-in, add a one-off message on day 2
curl -s -X POST $API/functions/updateEnrollment -H "authorization: Bearer $COACH" -H "$H" -d "{
  \"enrollment_id\":\"$ENR\",
  \"overrides\":[{\"item_id\":\"$HABIT_ITEM\",\"action\":\"move\",\"day\":3},{\"item_id\":\"$CHECKIN_ITEM\",\"action\":\"skip\"}],
  \"extra_items\":[{\"type\":\"message\",\"day\":2,\"text\":\"Quick one: how is sleep this week?\",\"send_time\":\"18:00\"}]
}" | jq '.enrollment | {overrides, extra_items}'      # extra item gets id "x-..."

# Habit start/end shifted by 2 days
curl -s "$API/entities/Habit?filter=$(jq -rn --arg e $ENR '{enrollment_id:$e}|@uri')" -H "authorization: Bearer $COACH" | jq '.[] | {start_date,end_date,is_active}'

# Skip the habit -> it's archived (is_active:false); remove the skip -> active again
curl -s -X POST $API/functions/updateEnrollment -H "authorization: Bearer $COACH" -H "$H" \
  -d "{\"enrollment_id\":\"$ENR\",\"overrides\":[{\"item_id\":\"$HABIT_ITEM\",\"action\":\"skip\"}]}" > /dev/null
curl -s -X POST $API/functions/updateEnrollment -H "authorization: Bearer $COACH" -H "$H" \
  -d "{\"enrollment_id\":\"$ENR\",\"overrides\":[]}" > /dev/null

# Pause (habits archived) and resume (habits re-activated)
curl -s -X POST $API/functions/updateEnrollment -H "authorization: Bearer $COACH" -H "$H" -d "{\"enrollment_id\":\"$ENR\",\"status\":\"paused\"}" | jq .enrollment.status
curl -s -X POST $API/functions/updateEnrollment -H "authorization: Bearer $COACH" -H "$H" -d "{\"enrollment_id\":\"$ENR\",\"status\":\"active\"}" | jq .enrollment.status

# Client can't call it
curl -s -X POST $API/functions/updateEnrollment -H "authorization: Bearer $CLIENT" -H "$H" -d "{\"enrollment_id\":\"$ENR\",\"status\":\"cancelled\"}"
```

## 7. LessonCompletion / CheckinResponse: members write their own only

```sh
LESSON_ITEM=$(echo "$ITEMS" | jq -r '.[] | select(.type=="lesson") | .id')

# OK
curl -s -X POST $API/entities/LessonCompletion -H "authorization: Bearer $CLIENT" -H "$H" -d "{
  \"enrollment_id\":\"$ENR\",\"lesson_id\":\"$LESSON\",\"item_id\":\"$LESSON_ITEM\",\"client_id\":\"$CLIENT_ID\",
  \"date\":\"$TODAY\",\"reflection_answer\":\"Greek yogurt and eggs\"}" | jq .id

curl -s -X POST $API/entities/CheckinResponse -H "authorization: Bearer $CLIENT" -H "$H" -d "{
  \"enrollment_id\":\"$ENR\",\"item_id\":\"$CHECKIN_ITEM\",\"client_id\":\"$CLIENT_ID\",\"date\":\"$TODAY\",
  \"values\":{\"weight\":182.4,\"rating\":4,\"note\":\"Good week\"}}" | jq .id

# Another client using this enrollment: 403 "You can only save records to your own program."
curl -s -X POST $API/entities/LessonCompletion -H "authorization: Bearer $OTHER" -H "$H" \
  -d "{\"enrollment_id\":\"$ENR\",\"lesson_id\":\"$LESSON\",\"item_id\":\"$LESSON_ITEM\",\"date\":\"$TODAY\"}"

# Another client using someone else's client_id: 403 "You can only save records to your own profile."
curl -s -X POST $API/entities/CheckinResponse -H "authorization: Bearer $OTHER" -H "$H" \
  -d "{\"client_id\":\"$CLIENT_ID\",\"item_id\":\"$CHECKIN_ITEM\",\"date\":\"$TODAY\",\"values\":{}}"
```

## 8. programTodayForMe (client)

```sh
curl -s -X POST $API/functions/programTodayForMe -H "authorization: Bearer $CLIENT" -H "$H" -d '{}' \
  | jq '{today, enrollments: [.enrollments[] | {name: .program.name, day, items: [.items[] | {type,title,status}], lessons: [.lessons[] | {day, title: .lesson.title, completed}]}]}'
```

## 9. unenrollFromProgram

```sh
curl -s -X POST $API/functions/unenrollFromProgram -H "authorization: Bearer $COACH" -H "$H" -d "{\"enrollment_id\":\"$ENR\"}" | jq .enrollment.status   # "cancelled"
curl -s "$API/entities/Habit?filter=$(jq -rn --arg e $ENR '{enrollment_id:$e}|@uri')" -H "authorization: Bearer $COACH" | jq '.[].is_active'  # false
# Cancelled enrollments never send messages
curl -s -X POST $API/cron/program-tick -H "x-cron-secret: $CRON_SECRET"
```
