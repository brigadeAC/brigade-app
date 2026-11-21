#!/usr/bin/env python3
"""Turn raw HSN exports (content/hsn/raw/) into an organized content library.

Outputs (content/hsn/):
  lessons/<pillar>/<slug>.md   one readable file per lesson
  videos.csv                   every lesson video link
  index.json                   all lessons in Brigade's Lesson shape (for import)
  files/                       downloaded PDFs / attachments  (--download)
  thumbnails/                  lesson cover images            (--download)
  README.md                    counts and how it's organized

Usage: python3 content/build_hsn.py [--download]
"""
import csv, html, json, re, sys, urllib.request, urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "hsn"
RAW = ROOT / "raw"
DOWNLOAD = "--download" in sys.argv

PILLAR_TO_CATEGORY = {
    "nutrition": "nutrition", "sleep": "sleep", "mindset": "mindset", "movement": "movement",
    "connection": "connection", "lifestyle": "lifestyle", "tips": "tips", "own your health": "lifestyle",
}


def slug(s, n=70):
    s = re.sub(r"[^a-z0-9]+", "-", (s or "untitled").lower()).strip("-")
    return (s[:n].rstrip("-")) or "untitled"


def html_text(h):
    if not h:
        return ""
    t = re.sub(r"<br\s*/?>", "\n", str(h), flags=re.I)
    t = re.sub(r"</(p|div|li|h\d)>", "\n", t, flags=re.I)
    t = re.sub(r"<li[^>]*>", "- ", t, flags=re.I)
    t = html.unescape(re.sub(r"<[^>]+>", "", t)).replace("\u00a0", " ")
    t = re.sub(r"[ \t]+\n", "\n", t)
    return re.sub(r"\n{3,}", "\n\n", t).strip()


def load_lessons():
    full = RAW / "lessons-full.json"
    out = []
    for l in json.loads(full.read_text()):
        out.append({
            "id": l.get("id"), "title": l.get("title"), "pillar": l.get("pillar"), "tags": l.get("tags"),
            "difficulty": l.get("difficulty"), "format": l.get("format"),
            "video": l.get("youtubeLink") or l.get("videoUrl"), "thumb": l.get("thumbnailUrl"),
            "description": html_text(l.get("description")), "tips": html_text(l.get("tipsSection")),
            "research": html_text(l.get("researchText")), "researchUrl": l.get("researchLinkUrl"),
            "reflection": l.get("reflectionQuestion") or l.get("reflectionQuestions") or l.get("reflectionPrompts"),
            "reflectionOptions": l.get("reflectionOptions") or [], "resources": l.get("resources") or [],
        })
    return out


def as_list(v):
    if not v:
        return []
    if isinstance(v, list):
        return [str(x) for x in v if str(x).strip()]
    return [str(v)]


def tips_list(t):
    lines = [re.sub(r"^[\s✓•\-\*\d\.\)️⃣]+", "", ln).strip() for ln in str(t or "").splitlines()]
    return [ln for ln in lines if ln]


def resource_urls(res):
    out = []
    for r in res or []:
        if isinstance(r, str):
            out.append({"name": r.rsplit("/", 1)[-1], "url": r})
        elif isinstance(r, dict):
            url = r.get("linkUrl") or r.get("url") or r.get("fileUrl") or r.get("link") or r.get("href")
            label = r.get("description") or r.get("name") or r.get("title")
            if url:
                out.append({"name": label or url.rsplit("/", 1)[-1], "url": url, "kind": "file"})
            if r.get("youtubeLink"):
                out.append({"name": label or "Video", "url": r["youtubeLink"], "kind": "video"})
    return out


def fetch(url, dest):
    if dest.exists() and dest.stat().st_size > 0:
        return True
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        return True
    except Exception as e:  # keep going; report at the end
        print(f"  ! download failed: {url} ({e})")
        return False


def main():
    lessons = load_lessons()
    batches = [RAW / "lessons-full.json"]
    print(f"{len(lessons)} lessons from {len(batches)} batches")

    (ROOT / "lessons").mkdir(parents=True, exist_ok=True)
    index, videos, failed = [], [], 0
    for l in lessons:
        pillar = (l.get("pillar") or "Other").strip()
        cat = PILLAR_TO_CATEGORY.get(pillar.lower(), "tips")
        name = slug(l.get("title"))
        md_path = ROOT / "lessons" / slug(pillar, 30) / f"{name}.md"
        md_path.parent.mkdir(parents=True, exist_ok=True)
        tips = tips_list(l.get("tips"))
        res = resource_urls(l.get("resources"))
        reflection = l.get("reflection")
        if isinstance(reflection, list):
            reflection = " / ".join(str(x) for x in reflection)

        local_files = []
        if DOWNLOAD:
            for r in [x for x in res if x.get("kind") == "file"]:
                fn = slug(Path(urllib.parse.urlparse(r["url"]).path).stem, 60) + (Path(urllib.parse.urlparse(r["url"]).path).suffix or ".bin")
                dest = ROOT / "files" / fn
                if fetch(r["url"], dest):
                    local_files.append(f"files/{fn}")
                else:
                    failed += 1
            if "--thumbs" in sys.argv and l.get("thumb"):
                ext = Path(urllib.parse.urlparse(l["thumb"]).path).suffix or ".png"
                if not fetch(l["thumb"], ROOT / "thumbnails" / f"{name}{ext}"):
                    failed += 1

        lines = [f"# {l.get('title','')}", "",
                 f"- **Pillar:** {pillar}",
                 f"- **Tags:** {', '.join(as_list(l.get('tags'))) or '-'}",
                 f"- **Format:** {l.get('format') or '-'}"]
        if l.get("video"):
            lines.append(f"- **Video:** {l['video']}")
        if l.get("thumb"):
            lines.append(f"- **Thumbnail:** {l['thumb']}")
        lines += ["", "## Description", "", (l.get("description") or "").strip() or "-"]
        if tips:
            lines += ["", "## Tips", ""] + [f"- {t}" for t in tips]
        if (l.get("research") or "").strip():
            lines += ["", "## Research", "", l["research"].strip()]
            if l.get("researchUrl"):
                lines.append(f"\nSource: {l['researchUrl']}")
        if reflection:
            lines += ["", "## Reflection question", "", str(reflection)]
        if res:
            lines += ["", "## Resources", ""] + [f"- [{r['name']}]({r['url']})" for r in res]
        md_path.write_text("\n".join(lines) + "\n")

        if l.get("video"):
            videos.append({"title": l.get("title"), "pillar": pillar, "video": l["video"], "lesson_file": str(md_path.relative_to(ROOT))})

        # Brigade Lesson entity shape (docs/programs-spec.md)
        index.append({
            "source": "hsn", "source_id": l.get("id"),
            "title": l.get("title"), "subtitle": "", "category": cat, "tags": as_list(l.get("tags")),
            "description": l.get("description") or "", "tips": tips,
            "research": l.get("research") or "", "research_url": l.get("researchUrl") or "",
            "cover_image_url": l.get("thumb") or "", "video_url": l.get("video") or "",
            "reflection_question": reflection or "", "resources": res, "local_files": local_files,
            "file": str(md_path.relative_to(ROOT)),
        })

    (ROOT / "index.json").write_text(json.dumps(index, indent=1, ensure_ascii=False))
    with open(ROOT / "videos.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["title", "pillar", "video", "lesson_file"])
        w.writeheader()
        w.writerows(videos)

    by_pillar = {}
    for i in index:
        by_pillar[i["file"].split("/")[1]] = by_pillar.get(i["file"].split("/")[1], 0) + 1
    other = sorted(p.name for p in (RAW / "other").glob("*.json")) if (RAW / "other").exists() else []
    readme = ["# HSN content library", "",
              "Exported from Brigade's HSN (Healthy Steps Nutrition) admin account for reuse in the Brigade app.", "",
              f"- Lessons: **{len(index)}** (`lessons/<pillar>/`)",
              f"- Lessons with video: **{len(videos)}** (`videos.csv`)",
              f"- Lessons with attachments: **{sum(1 for i in index if i['resources'])}**",
              "- `index.json`: every lesson in the Brigade Lesson Library shape, ready to import",
              "- `raw/`: the exported data as received", "",
              "## Lessons by pillar", ""] + [f"- {k}: {v}" for k, v in sorted(by_pillar.items())]
    if other:
        readme += ["", "## Other exports (raw/other/)", ""] + [f"- {o}" for o in other]
    (ROOT / "README.md").write_text("\n".join(readme) + "\n")
    print(f"wrote {len(index)} lesson files, {len(videos)} videos; download failures: {failed}")


if __name__ == "__main__":
    main()
