#!/usr/bin/env python3
"""Readable files for HSN habits, recipes, programs and challenge templates
(from content/hsn/raw/other/). Run after build_hsn.py."""
import json, re, glob
from pathlib import Path
ROOT = Path(__file__).resolve().parent / "hsn"; RAW = ROOT / "raw" / "other"
slug = lambda s: re.sub(r"[^a-z0-9]+", "-", (s or "x").lower()).strip("-")[:70] or "x"
load_all = lambda pat: [x for f in sorted(RAW.glob(pat)) for x in json.load(open(f))]

# Habits: one file, grouped by category
habits = load_all("habits-*.json"); by = {}
for h in habits: by.setdefault(h.get("category") or "Other", []).append(h)
out = ["# HSN habits", "", f"{len(habits)} habits.", ""]
for cat in sorted(by):
    out += [f"## {cat}", ""]
    for h in sorted(by[cat], key=lambda x: x.get("name") or ""):
        out.append(f"### {h.get('name')}")
        for k, label in (("description", "Description"), ("whyShownToClient", "Why"), ("proTips", "Pro-Tips")):
            if (h.get(k) or "").strip(): out.append(f"**{label}:** {h[k].strip()}\n")
        for i, l in enumerate(h.get("layers") or [], 1):
            out.append(f"- Level {i}: {l.get('title','')} ({l.get('durationWeeks','?')} wk) {l.get('description','')}")
        out.append("")
(ROOT / "habits.md").write_text("\n".join(out))

# Recipes: one file each
recipes = load_all("recipes-*.json"); (ROOT / "recipes").mkdir(exist_ok=True)
for r in recipes:
    n = r.get("nutrition") or {}
    lines = [f"# {r.get('title')}", "", r.get("description") or "", "",
             f"- **Meal:** {r.get('mealType') or '-'} · **Servings:** {r.get('servings') or '-'} · **Prep/Cook:** {r.get('prepTimeMins') or 0}/{r.get('cookTimeMins') or 0} min",
             f"- **Tags:** {', '.join(r.get('dietaryTags') or []) or '-'}"]
    if n: lines.append("- **Nutrition (per serving):** " + ", ".join(f"{k} {v}" for k, v in n.items() if v not in (None, "", 0)))
    if r.get("imageUrl"): lines.append(f"- **Image:** {r['imageUrl']}")
    if r.get("recipeLink"): lines.append(f"- **Source:** {r['recipeLink']}")
    lines += ["", "## Ingredients", ""] + [f"- {i.get('quantity','')} {i.get('unit','')} {i.get('name','')}".replace("  ", " ") for i in (r.get("ingredients") or [])]
    ins = r.get("instructions")
    if ins:
        steps = ins if isinstance(ins, list) else [s for s in str(ins).split("\n") if s.strip()]
        lines += ["", "## Instructions", ""] + [f"{i}. {s if isinstance(s,str) else s.get('text', s)}" for i, s in enumerate(steps, 1)]
    (ROOT / "recipes" / f"{slug(r.get('title'))}.md").write_text("\n".join(lines) + "\n")

# Programs: week x day calendar
(ROOT / "programs").mkdir(exist_ok=True); progs = []
for f in sorted(RAW.glob("program-*.json")):
    p = json.load(open(f)); progs.append(p.get("title"))
    lines = [f"# {p.get('title')}", "", f"{p.get('durationDays')} days.", ""]
    for w in p.get("weeks", []):
        lines += [f"## Week {w['week']}", "", "| Day | Lesson | Habit(s) |", "|---|---|---|"]
        for d in w.get("days", []):
            hab = sorted({h["title"] for h in d.get("habits", [])})
            hab_s = "; ".join(hab[:3]) + (f" (+{len(hab)-3} more)" if len(hab) > 3 else "")
            lesson_s = "; ".join(l["title"] for l in d.get("lessons", [])).replace("|", "/")
            lines.append(f"| {d['dayIndex']} | {lesson_s or '-'} | {hab_s.replace('|', '/') or '-'} |")
        lines.append("")
    (ROOT / "programs" / f"{slug(p.get('title'))}.md").write_text("\n".join(lines))

# Challenge templates
ct = json.load(open(RAW / "challenge-templates.json")).get("templates", [])
out = ["# HSN challenge templates", ""]
for t in ct:
    out += [f"## {t.get('title')}", "", f"- **Type:** {t.get('challenge_type')} · **Duration:** {t.get('duration')}"]
    if t.get("goal"): out.append(f"- **Goal:** {t['goal']}")
    if t.get("daily_targets") or t.get("targets"): out.append(f"- **Daily targets:** {json.dumps(t.get('daily_targets') or t.get('targets'))}")
    if t.get("scoring_matrix"): out.append(f"- **Scoring:** {json.dumps(t['scoring_matrix'], ensure_ascii=False)}")
    if t.get("guardrails"): out.append(f"- **Guardrails:** {json.dumps(t['guardrails'], ensure_ascii=False)}")
    if t.get("about"): out += ["", t["about"]]
    out.append("")
(ROOT / "challenge-templates.md").write_text("\n".join(out))
print(f"habits {len(habits)}, recipes {len(recipes)}, programs {len(progs)}, challenge templates {len(ct)}")
