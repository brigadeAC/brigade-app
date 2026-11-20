# Programs, Lessons & Calendars: build spec (v1)

Source of truth for the parallel build. Read this fully before writing code.
Design reference: `docs/research/hsn-admin-panel.md` (HSN, the platform Eric uses today).

## Ground rules (all agents)
- App: React + Vite frontend (`src/`), one Cloudflare Pages Functions backend
  (`functions/api/[[path]].js`), D1 `entities` table with JSON `data`, accessed from
  the frontend via `base44.entities.<Type>.list/filter/create/update/delete` and
  `base44.functions.invoke(name, payload)`. New entity types need no migration.
- **Data ownership:** records belong to the gym or the client, never a coach.
  Staff (trainers + admins) all see the same data. `trainer_id` is only "assigned coach".
- **Only edit the files you own** (see Ownership). Shared files (`Layout.jsx`,
  `pages.config.js`, `src/lib/programs.js`, this spec) are already set up; if you need
  a change there, say so in your final report instead of editing.
- Don't run the dev server, deploy, commit, or touch `dist/`. To check your code
  compiles, run: `npx vite build --outDir /tmp/brigade-build-<your-agent-name> --emptyOutDir`
  and `npx eslint <your files>` (pre-existing lint errors in other files are not yours).
- Brand: existing shadcn/ui components in `src/components/ui`, Tailwind tokens
  (`bg-card`, `text-foreground`, `text-muted-foreground`, `border-border`, `bg-primary`).
  Copy style from `src/pages/HabitLibrary.jsx` and `src/components/habits/*`.
  Mobile-first: coaches and clients use phones. 16px side padding, no horizontal scroll
  except inside the week grid container.
- Dates: always local calendar dates (`yyyy-MM-dd`), via helpers in `src/lib/programs.js`.
  Never `new Date("yyyy-MM-dd")` (reads as UTC, shows a day early).
- Every SMS-style message copy Brigade writes: no exclamation points, ends with a question.
  (Program messages are written by coaches; just don't add your own hype copy in UI text.)

## Entities

### Lesson (gym library; everyone reads, staff writes)
`title, subtitle, category, tags[], description, tips[] (strings), research,
research_url, cover_image_url, video_url, reflection_question, is_archived`
- `category` ∈ nutrition | sleep | mindset | movement | connection | lifestyle | tips
- `video_url`: YouTube or Vimeo link; render with `toEmbedUrl()` from `src/lib/programs.js`.

### HabitTemplate (exists) - add `tips` (string, newline-separated "Pro-Tips")
Also `days_of_week` (array of 0-6, Sun=0) is allowed on templates and habits; empty or
missing = every day.

### Program (gym library; everyone reads, staff writes)
`name, description, duration_weeks, cover_image_url, status: draft|published, kind: program|challenge`

### ProgramItem (gym library; everyone reads, staff writes)
`program_id, day (1-based, 1..duration_weeks*7), type, sort, ...type fields`
- `type: "lesson"` -> `lesson_id`
- `type: "habit"` -> habit fields copied from a library entry (`habitFromTemplate()` in
  `src/lib/habitLibrary.js`) plus `end_day` (inclusive; empty = runs to program end) and
  optional `days_of_week`. The habit starts on `day`.
- `type: "message"` -> `text`, `send_time` ("HH:mm", default "09:00", Eastern).
  Sent from the client's assigned coach through the in-app 1:1 chat.
- `type: "workout"` -> `workout_plan_id`, `workout_day` (the plan's day number), `title`
- `type: "checkin"` -> `title`, `fields[]` ⊆ weight | body_fat | waist | photo | rating | note

### ProgramEnrollment (client record; staff + that client read)
`program_id, program_name, client_id (Client record id), client_user_id, trainer_id,
start_date (yyyy-MM-dd), status: active|paused|completed|cancelled,
overrides: [{ item_id, action: "skip" | "move", day }], extra_items: [ProgramItem-shaped, id = "x-<random>"]`
- Per-client changes never touch the template. Template edits apply to everyone, but
  the client calendar only shows/sends future items from the current template.

### LessonCompletion (client record)
`enrollment_id, lesson_id, item_id, client_id, client_user_id, date, reflection_answer`

### CheckinResponse (client record)
`enrollment_id, item_id, client_id, client_user_id, date, values: {weight, body_fat, waist, photo_url, rating, note}`

### ProgramMessageLog (system)
`enrollment_id, item_id, client_id, scheduled_for (ISO), sent_at, message_id, status: sent|skipped|failed`

### Habit (exists) - program-created habits add:
`program_id, enrollment_id, item_id, start_date, end_date (yyyy-MM-dd, inclusive), days_of_week`
The habit tracker must hide a habit on dates outside start/end and on non-scheduled
weekdays, and those days must not count against compliance or the daily ring.

## Backend (owned by agent `programs-backend`)
In `functions/api/[[path]].js`:
1. Add `Lesson`, `Program`, `ProgramItem` to `STAFF_LIBRARY_TYPES` (everyone reads,
   members can't write). `ProgramEnrollment` writes: staff only (members read their own
   through normal ownership scope; enrollment has `client_id`/`client_user_id`).
   `LessonCompletion` / `CheckinResponse`: members may create for themselves (existing
   `memberWriteViolation` client_id rule applies) and may not change `enrollment_id`
   to one that isn't theirs.
2. `functions.invoke('enrollInProgram', { program_id, client_id, start_date })` (staff):
   creates the ProgramEnrollment, creates the client's Habit records for each habit item
   (dates computed from start_date), returns the enrollment.
   `unenrollFromProgram({ enrollment_id })`: status cancelled, program habits archived
   (`is_active:false`, history kept).
   `updateEnrollment({ enrollment_id, overrides?, extra_items?, start_date?, status? })`:
   saves and re-syncs program habits (move dates, archive skipped).
3. Message delivery: `runProgramTick(env, { enrollmentId? })` sends every program
   message whose scheduled time (start_date + day-1, send_time America/New_York) has
   passed and has no ProgramMessageLog row, skipping overrides with action skip and
   honoring moved days and extra_items. Sending = create a Message row exactly like
   `src/pages/Messages.jsx` does (conversation_id = sorted [coachUserId, clientUserId]
   joined by "-", sender = assigned coach, `read:false`) + a Notification
   `{ user_id: clientUserId, type:'message', title:'New message', message:'<Coach name>: …', link:'/Messages' }`
   (that already triggers push). Skip (log status skipped) if the client has no login yet.
   Don't send messages older than 3 days (log skipped) so a late start doesn't dump a backlog.
   Entry points:
   - `POST /api/cron/program-tick` with header `x-cron-secret: env.CRON_SECRET` (all enrollments).
   - Lazy fallback: `functions.invoke('programTick')` callable by any signed-in user;
     ticks only the caller's own enrollments (or all, for staff). The client app calls it on load.
   - Scaffold `workers/program-cron/` (a tiny Worker with a `*/15 * * * *` cron that POSTs
     to the endpoint, own `wrangler.toml`, README with the two commands Eric runs to deploy
     it and set CRON_SECRET). Do not deploy it.
4. `functions.invoke('programCalendar', { enrollment_id, from, to })` returns the
   materialized items per date for one enrollment with status for each:
   lesson done/not, habit done/not (from HabitLog), message sent/scheduled/skipped,
   workout logged/not (WorkoutLog by date), check-in done/not. Both calendar UIs use this.
   Shape: `{ enrollment, days: [{ date, day, items: [{ item_id, type, title, status, ref }] }] }`.
   `status` ∈ done | missed | upcoming | sent | scheduled | skipped.
5. `functions.invoke('programTodayForMe')` (client): their active enrollment(s), today's
   day number, today's items (same shape), plus unlocked lessons list
   (lesson items with day <= today, with completion status).

## Shared helpers (already written: `src/lib/programs.js`)
`dayNumberFor(startDate, date)`, `dateForDay(startDate, day)`, `todayKey()`,
`weekAndDay(day)`, `ITEM_TYPES`, `toEmbedUrl(url)`, `isScheduledOn(habit, dateKey)`.
The backend copies the same date math (it can't import from src).

## Frontend ownership
| Agent | Owns |
|---|---|
| `lesson-library` | `src/pages/LessonLibrary.jsx`, `src/components/lessons/*` (LessonEditor, LessonViewer with video embed + tips + research + reflection), habit `tips` + `days_of_week` UI in `src/components/habits/HabitFields.jsx` and display of tips in `HabitPicker.jsx` / `src/pages/HabitLibrary.jsx` |
| `program-builder` | `src/pages/Programs.jsx` (list, create, duplicate, publish/draft), `src/pages/ProgramBuilder.jsx` (week x day grid; chips per item type; tap day = add item; tap chip = edit; drag chip to another day; item editors for lesson (pick from library via a picker, plus "new lesson" opening `LessonEditor` from `src/components/lessons/LessonEditor.jsx`; import it, don't edit it), habit (reuse `HabitPicker`), message, workout (pick WorkoutPlan + day), check-in), `src/components/programs/builder/*` |
| `client-program` | `src/components/programs/client/*`: EnrollDialog (pick program + start date, calls enrollInProgram), ClientProgramCalendar (month grid via programCalendar; per-client skip/move/add one-off; status colors), ProgramTab for the coach's client profile (calendar + enrollment controls + lesson completions + check-in answers); ClientTodayCard for the client dashboard (today's lesson, habits, check-in; calls programTick then programTodayForMe); `src/pages/ClientProgram.jsx` (client: unlocked lessons list, lesson viewer via `LessonViewer` from `src/components/lessons/LessonViewer.jsx`, mark complete + reflection answer, check-in form). Also small integration edits: add a "Program" tab to `src/pages/ClientProfile.jsx`, render `ClientTodayCard` near the top of `src/pages/ClientDashboard.jsx`, and make `src/components/habits/TrophyHabitTracker.jsx` + the dashboard habit list respect start/end dates and days_of_week via `isScheduledOn()` |
| `programs-backend` | `functions/api/[[path]].js`, `workers/program-cron/*` |

`lesson-library` must export, with these exact props, early (stub first, then fill in)
so other agents can import them:
- `LessonEditor({ open, onOpenChange, lesson /* null = new */, onSaved(lesson) })`
- `LessonViewer({ lesson, completed, reflectionAnswer, onComplete({ reflection_answer }) /* optional */ })`
- `LessonPicker({ open, onOpenChange, onPick(lesson) })` (search + category filter)

## Done means
- Your files build and lint clean; you list every file you created/changed, every
  assumption, and anything you needed from a shared file.
- Backend: each endpoint exercised with curl against a local server is the
  integrator's job; you write `docs/programs-backend-test.md` with the curl calls.
