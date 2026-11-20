# HSN (Healthy Steps Nutrition) admin panel: design reference

Reviewed 2026-11-20 (read-only) as input for Brigade Programs, Challenges and the
coach calendar views. No client data is recorded here.

## Content library
- **Lessons (426):** category (Nutrition, Sleep, Mindset, Movement, Connection,
  Lifestyle, Tips) + tags. Fields: title, subtitle (one line), description,
  tips list, research section with citation (PubMed link), cover image,
  YouTube embed.
- **Habits (78):** name, category, "Why" paragraph, "Pro-Tips & Notes". Many are
  progression ladders (15 -> 30 -> 45 min movement; eliminate distractions ->
  + chew 15-20x -> + stop at ~70% full). "Active assignments" count per habit.
- **Recipes (127):** meal type, minutes, calories, dietary tags, dietitian-approved
  flag, "top planned" stats.
- **Programs (6):** 4-week resets, 6-week wellness, 34-week individual coaching.

## Program builder = week x day grid
Rows = weeks, columns = Day 1..7. Each cell: one lesson + the active habit.
Clicking a day shows "Week N, Day N: Lesson / Habit". One focus habit per week
(e.g. protein at breakfast -> plate method -> 30g fiber -> added-sugar limit).
In the 34-week coaching program the habit is scheduled weekdays only (M-F).

## Client profile tabs
Overview, Calendar, Meal Log, Habit Compliance, Achievement, Progress,
Other Pillars, Message, Notes, Billing, Challenges, Action.
- **Overview:** age/sex, height/weight, activity level, primary goal, dietary
  prefs, allergies, assigned coach (change coach), engagement status, start
  date, length of engagement (LEG), last login, macro goals (cal/P/C/F/added
  sugar/fiber), goal statement ("lose X lb in 4-6 months"), two "why" prompts
  ("Why does this goal matter now?", "How would improving your health impact
  the people you love or lead?"), wearables (Apple Health, Fitbit, Oura,
  Garmin, Whoop), favorites, notification preferences, reflection responses.
- **Calendar:** month grid. Each date: lesson, habit, nutrition totals
  (cal/P/C/F/sugar/fiber), sleep vs target, steps vs target; completed /
  not completed coloring; "View" per day.
- **Habit Compliance:** current/past habits; started, expires, longest streak,
  total completed, compliance %, days to practice (Daily or M/T/W/T/F),
  month-by-month compliance calendars. Targets (steps/sleep) tracked the same way.
- **Achievement:** badge categories with milestones: Fuel Tracker (1/3/25/50/
  100/150 meals), Habit Builder, Informed & Empowered (lessons), Community,
  Planned & Prepared, Challenge.
- **Progress:** body composition (muscle, weight, body fat %, water weight),
  8 tape measurements, blood work, progress photos; date ranges.
- **Other Pillars:** sleep (duration, stages, start/end, 30-day avg, HRV) and
  movement from wearables.
- **Billing:** plans per client; payments made outside the platform recorded.

## Engagement scoring
- Client: High Risk < 1 daily action, At Risk 1-2, Engaged 2-4,
  High Performer 4+. Daily action = any meaningful action (habit, meal plan/
  track, recipe, lesson, community, message coach, wearable, manual steps/
  sleep, biometrics, goal change).
- Coach: % clients with goal & "transformational identity", % active habits,
  response time (<15h / 15-24h / >24h), % clients logged in.

## Challenges
Types: **Classic** (program: lessons + habits + meal planning + chat +
leaderboard) and **Target Engagement** (daily targets only, usually 14 days).
Template tabs: Overview (goal, about, daily targets, tracking mode
device + manual), Program, Scoring Matrix, Guardrails.

Scoring matrix (Fall Reset): complete habit 1; water 60 oz 1; steps 7,000 1;
sleep 7 h 1; track nutrition max 1 (track food 0.25, plan food 0.25);
complete lesson 1; challenge chat max 1 (like/react 0.25, post/comment 0.5).

Guardrails (system-enforced): group chat per challenge; total leaderboard;
engagement points only from the challenge chat; points only from
challenge-defined habits/targets/lessons; AI habit recommendations off during
challenge; client's own program pauses during challenge (optional); scoring
locked after start; only end date editable after start; daily engagement cap;
1:1 chat and AI chat don't count.

Completed challenge dashboard: participants, conversion to coaching/
subscription, % engaged/high performer, revenue, weekly + total leaderboard
top 3, scoring breakdown by category (% of possible), reflection answers.
Challenges are sold as a one-time plan (e.g. $149).

## Other
- Coaches: avg clients/coach, avg client LEG, certification status/expiry.
- Staff roles: Coach, Nutrition Coach+, Head Nutrition Coach.
- Messaging: All / Staff / Conversation; unread, starred.
- Business community group with channels (#chat, updates).
