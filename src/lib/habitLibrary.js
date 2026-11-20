// Prebuilt habit library. Coaches assign these to clients as-is or with their
// own target. Gym-specific habits coaches save live in the HabitTemplate
// entity and are shown alongside these.
//
// tracking: "check"  -> done / not done
//           "number" -> log an amount; done when it reaches target_value
// frequency: "daily", or "weekly" with days_per_week

export const HABIT_CATEGORIES = [
  { id: "nutrition", label: "Nutrition" },
  { id: "hydration", label: "Hydration" },
  { id: "sleep", label: "Sleep" },
  { id: "movement", label: "Movement" },
  { id: "recovery", label: "Recovery" },
  { id: "mindset", label: "Mindset" },
  { id: "lifestyle", label: "Lifestyle" },
];

const h = (id, category, icon, name, description, extra = {}) => ({
  id: `builtin:${id}`,
  builtin: true,
  category,
  icon,
  name,
  description,
  tracking: "check",
  target_value: 1,
  unit: "",
  frequency: "daily",
  days_per_week: 7,
  ...extra,
});

export const BUILTIN_HABITS = [
  // Nutrition
  h("protein_goal", "nutrition", "🍗", "Hit protein target", "Protein keeps you full and helps you recover and build muscle.", { tracking: "number", target_value: 150, unit: "g" }),
  h("protein_each_meal", "nutrition", "🥚", "Protein at every meal", "A palm-sized portion of protein at each meal makes the daily target easy."),
  h("veggies", "nutrition", "🥦", "Eat vegetables", "Fiber, vitamins and volume for very few calories.", { tracking: "number", target_value: 5, unit: "servings" }),
  h("fruit", "nutrition", "🍎", "Eat fruit", "An easy way to get fiber and micronutrients.", { tracking: "number", target_value: 2, unit: "servings" }),
  h("log_meals", "nutrition", "📝", "Log all meals", "Writing it down is the fastest way to see what's really going on."),
  h("follow_meal_plan", "nutrition", "🥗", "Follow meal plan", "Stick to the plan your coach built for today."),
  h("no_late_eating", "nutrition", "🌙", "No eating 2 hours before bed", "Helps sleep quality and cuts mindless evening snacking."),
  h("eat_slowly", "nutrition", "🍽️", "Eat slowly", "Put the fork down between bites. Fullness takes about 20 minutes to register."),
  h("no_sugary_drinks", "nutrition", "🥤", "No sugary drinks", "Liquid calories add up fast and don't fill you up."),
  h("limit_alcohol", "nutrition", "🍷", "Alcohol-free day", "Better sleep, better recovery, fewer empty calories."),
  h("meal_prep", "nutrition", "🍱", "Meal prep", "Cooking ahead makes good choices the easy ones.", { frequency: "weekly", days_per_week: 2 }),
  h("calorie_target", "nutrition", "🔢", "Stay within calorie target", "Keep the day's calories within your target range.", { tracking: "number", target_value: 2000, unit: "kcal" }),
  h("creatine", "nutrition", "💊", "Take creatine", "3-5 g a day. Timing doesn't matter, consistency does."),
  h("supplements", "nutrition", "💊", "Take supplements", "Whatever you and your coach agreed on."),

  // Hydration
  h("water", "hydration", "💧", "Drink water", "Even mild dehydration hurts energy and performance.", { tracking: "number", target_value: 3, unit: "L" }),
  h("water_on_waking", "hydration", "🥛", "Glass of water on waking", "Start the day hydrated before coffee."),
  h("electrolytes", "hydration", "⚡", "Electrolytes on training days", "Replace the salt you sweat out, especially in hot weather."),

  // Sleep
  h("sleep_hours", "sleep", "🛌", "Sleep 7+ hours", "Sleep is when you recover. Most adults need 7-9 hours.", { tracking: "number", target_value: 7, unit: "hours" }),
  h("consistent_bedtime", "sleep", "⏰", "Same bedtime", "Going to bed at the same time (within 30 min) sets your body clock."),
  h("no_screens_bed", "sleep", "📵", "No screens 30 min before bed", "Gives your brain time to wind down."),
  h("no_caffeine_late", "sleep", "☕", "No caffeine after 2pm", "Caffeine stays in your system for hours and disrupts deep sleep."),
  h("morning_light", "sleep", "☀️", "Morning sunlight", "5-10 minutes outside soon after waking helps set your sleep cycle."),

  // Movement
  h("workout", "movement", "🏋️", "Complete workout", "Show up and get the session done."),
  h("class", "movement", "💪", "Attend class", "Get to the gym for a class.", { frequency: "weekly", days_per_week: 3 }),
  h("steps", "movement", "👣", "Daily steps", "Walking is the easiest way to raise daily energy burn.", { tracking: "number", target_value: 8000, unit: "steps" }),
  h("walk_after_meal", "movement", "🚶", "Walk after a meal", "A 10-minute walk after eating helps blood sugar and digestion."),
  h("zone2", "movement", "🚴", "Zone 2 cardio", "Easy, conversational-pace cardio builds your aerobic base.", { tracking: "number", target_value: 30, unit: "min", frequency: "weekly", days_per_week: 2 }),
  h("active_minutes", "movement", "🏃", "Active minutes", "Any movement that gets your heart rate up counts.", { tracking: "number", target_value: 30, unit: "min" }),
  h("stand_breaks", "movement", "🧍", "Stand up every hour", "Break up long sitting with a minute or two on your feet."),

  // Recovery
  h("mobility", "recovery", "🤸", "Mobility work", "Keeps joints moving well and helps prevent injury.", { tracking: "number", target_value: 10, unit: "min" }),
  h("stretch", "recovery", "🧘", "Stretch", "A few minutes of stretching after training or before bed."),
  h("foam_roll", "recovery", "🌀", "Foam roll", "Loosen up tight spots before or after training."),
  h("rest_day", "recovery", "🛋️", "Take a real rest day", "Recovery is part of training.", { frequency: "weekly", days_per_week: 1 }),
  h("cold_heat", "recovery", "🧊", "Sauna or cold plunge", "Optional recovery tool. Enjoy it if it helps you.", { frequency: "weekly", days_per_week: 2 }),

  // Mindset
  h("meditate", "mindset", "🧠", "Meditate", "A few minutes of quiet focus lowers stress.", { tracking: "number", target_value: 10, unit: "min" }),
  h("breathing", "mindset", "🌬️", "Breathing exercise", "Slow breathing (like 4 seconds in, 6 out) calms you down fast."),
  h("journal", "mindset", "✍️", "Journal", "A few lines about your day, training and how you feel."),
  h("gratitude", "mindset", "🙏", "Write 3 things you're grateful for", "A simple habit that improves mood over time."),
  h("read", "mindset", "📚", "Read", "Time away from screens with a book.", { tracking: "number", target_value: 20, unit: "min" }),
  h("visualize", "mindset", "🎯", "Review your goals", "Remind yourself what you're working toward and why."),

  // Lifestyle
  h("weigh_in", "lifestyle", "⚖️", "Morning weigh-in", "Same time, same conditions. Watch the weekly trend, not the daily number."),
  h("progress_photo", "lifestyle", "📸", "Progress photo", "Photos show changes the scale misses.", { frequency: "weekly", days_per_week: 1 }),
  h("outside", "lifestyle", "🌿", "Time outside", "Fresh air and daylight help mood and energy.", { tracking: "number", target_value: 20, unit: "min" }),
  h("screen_time", "lifestyle", "📱", "Limit social media", "Keep recreational scrolling under your limit.", { tracking: "number", target_value: 60, unit: "min max" }),
  h("plan_tomorrow", "lifestyle", "🗓️", "Plan tomorrow", "Decide tonight when you'll train and what you'll eat."),
  h("check_in", "lifestyle", "💬", "Check in with your coach", "A quick message on how the week is going.", { frequency: "weekly", days_per_week: 1 }),
];

// Fields copied from a library entry onto a client's Habit.
export function habitFromTemplate(t) {
  return {
    name: t.name,
    icon: t.icon || "⭐",
    category: t.category || "lifestyle",
    description: t.description || "",
    tracking: t.tracking || "check",
    target_value: t.tracking === "number" ? Number(t.target_value) || 1 : 1,
    unit: t.tracking === "number" ? t.unit || "" : "",
    frequency: t.frequency || "daily",
    days_per_week: t.frequency === "weekly" ? Number(t.days_per_week) || 3 : 7,
    template_id: t.id || null,
  };
}

// "max" units (e.g. "60 min max") are limits: done when at or under target.
export const isLimitHabit = (habit) => /\bmax\b/i.test(habit?.unit || "");

export function isLogDone(habit, log) {
  if (!log) return false;
  if ((habit?.tracking || "check") !== "number") return !!log.completed;
  if (log.value === undefined || log.value === null || log.value === "") return !!log.completed;
  const v = Number(log.value);
  return isLimitHabit(habit) ? v <= Number(habit.target_value) : v >= Number(habit.target_value);
}

export function formatTarget(habit) {
  const freq = habit.frequency === "weekly" ? `${habit.days_per_week || 3}x / week` : "daily";
  if ((habit.tracking || "check") === "number") {
    const n = Number(habit.target_value);
    return `${n.toLocaleString()} ${habit.unit || ""}`.trim() + ` · ${freq}`;
  }
  return freq;
}

// The library coaches pick from: prebuilt habits plus the gym's HabitTemplate
// rows. A template with `overrides: "builtin:<id>"` replaces that prebuilt
// habit (an edit), or removes it when `hidden` is true.
export function mergeLibrary(gymTemplates = [], { includeHidden = false } = {}) {
  const overrides = new Map();
  const own = [];
  for (const t of gymTemplates) {
    if (t.overrides) overrides.set(t.overrides, t);
    else own.push({ ...t, builtin: false });
  }
  const builtins = [];
  for (const b of BUILTIN_HABITS) {
    const o = overrides.get(b.id);
    if (!o) { builtins.push(b); continue; }
    if (o.hidden && !includeHidden) continue;
    builtins.push({
      ...b,
      ...Object.fromEntries(Object.entries(o).filter(([k, v]) => v !== undefined && v !== null && k !== "id")),
      id: b.id,
      builtin: true,
      edited: !o.hidden && !!o.name,
      hidden: !!o.hidden,
      override_id: o.id,
    });
  }
  return [...own, ...builtins];
}
