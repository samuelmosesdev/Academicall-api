#!/usr/bin/env python3
"""
Builds prisma/data/curricula.json.gz from "Nigerian_Institutions_Programme_Courses.docx".

    pandoc Nigerian_Institutions_Programme_Courses.docx -t json -o /tmp/courses.json
    python3 scripts/build-curricula-data.py /tmp/courses.json

Each curriculum (one "## heading" in the document) keeps:
  name, tier (degree | nd | nce), edition, the JAMB abbreviations of institutions
  that offer it, the JAMB programme names it was matched from ("Listed in JAMB as"),
  and its courses: level, semester, code, title, units, status, legacy flag.
Legacy = the older NUC BMAS departmental list printed under a CCMAS programme.
The API seed matches curricula to Program rows by institution abbreviation + programme name.
"""
import gzip, json, re, sys, datetime, os

src = sys.argv[1] if len(sys.argv) > 1 else "/tmp/courses.json"
out = os.path.join(os.path.dirname(__file__), "..", "prisma", "data", "curricula.json.gz")
d = json.load(open(src))

def txt(inl):
    o = []
    for x in inl:
        t = x["t"]
        if t == "Str": o.append(x["c"])
        elif t in ("Space", "SoftBreak", "LineBreak"): o.append(" ")
        elif t in ("Emph", "Strong", "Underline", "SmallCaps", "Strikeout", "Superscript", "Subscript"): o.append(txt(x["c"]))
        elif t in ("Span", "Link"): o.append(txt(x["c"][1]))
        elif t == "Quoted": o.append('"' + txt(x["c"][1]) + '"')
        elif t == "Code": o.append(x["c"][1])
    return "".join(o)

def btxt(bs): return " ".join(txt(b["c"]) for b in bs if b["t"] in ("Para", "Plain")).strip()

def rows(b):
    c = b["c"]; out = []
    for body in c[4]:
        for r in body[2] + body[3]:
            out.append([btxt(cell[4]) for cell in r[1]])
    return out

def clean(s): return re.sub(r"\s+", " ", s or "").strip()
def code_norm(c):
    c = clean(c).upper().replace("–", "-")
    m = re.match(r"^([A-Z]{2,5})\s*-?\s*(\d{3}[A-Z]?)$", c)
    return f"{m.group(1)} {m.group(2)}" if m else c
def title_fix(t):
    t = clean(t)
    t = re.sub(r"\s+\d-\d-\d$", "", t)  # NCCE contact-hour suffix "2-1-0"
    t = re.sub(r"^[/,;:.\-–\s]+", "", t)
    if t.isupper() and len(t) > 4:
        t = t.title()
        t = re.sub(r"\b(Ii|Iii|Iv|Vi|Vii|Viii|Ix|Xi|Xii)\b", lambda m: m.group(1).upper(), t)
        t = re.sub(r"(?<!^)\b(And|Of|In|The|For|To|On|With|At|A|An)\b", lambda m: m.group(1).lower(), t)
        t = re.sub(r"\b(Ict|Siwes|Gis|Cad|Hiv|Aids|Ii)\b", lambda m: m.group(1).upper(), t)
    return t
def units(u):
    m = re.match(r"^\d+(\.\d+)?$", clean(u))
    return int(float(u)) if m else None
def sem(s):
    s = clean(s).lower()
    return "1st" if s.startswith("1") else "2nd" if s.startswith("2") else None
def sem_from_code(code):
    m = re.search(r"(\d)\D*$", code)
    if not m: return None
    return "1st" if int(m.group(1)) % 2 == 1 else "2nd"

blocks = d["blocks"]
tier = None; cur = None; curricula = []; mode = None
for b in blocks:
    t = b["t"]
    if t == "Header":
        lvl, text = b["c"][0], clean(txt(b["c"][2]))
        if lvl == 1:
            tier = "degree" if text.startswith("Part A") else "nd" if text.startswith("Part B") else "nce" if text.startswith("Part C") else None
            cur = None
        elif lvl == 2 and tier:
            cur = {"name": text, "tier": tier, "edition": None, "institutions": [], "aliases": [], "courses": []}
            curricula.append(cur); mode = "current"
        continue
    if not cur: continue
    if t in ("Para", "Plain"):
        p = clean(txt(b["c"]))
        if p.startswith("Edition:"): cur["edition"] = clean(p[8:])
        elif p.startswith("Offered at"):
            cur["institutions"] = [clean(x) for x in p.split(":", 1)[1].split(",") if clean(x)]
        elif p.startswith("Listed in JAMB as:"):
            cur["aliases"] = sorted({clean(x).rstrip(":").strip() for x in p.split(":", 1)[1].split(";") if clean(x)})
        elif p.startswith("Older curriculum"):
            mode = "legacy"; cur["legacyEdition"] = clean(p.split("–", 1)[-1].split("– departmental")[0]) if "–" in p else p
            m = re.search(r"NUC BMAS \(([^)]*)\)", p); cur["legacyEdition"] = f"NUC BMAS ({m.group(1)})" if m else "NUC BMAS"
        elif mode == "legacy":
            m = re.match(r"^(\d{3}) Level:\s*(.*)$", p)
            if m:
                level = f"{m.group(1)} Level"
                for part in m.group(2).split(";"):
                    part = clean(part)
                    mm = re.match(r"^([A-Z]{2,5}\s?-?\s?\d{3}[A-Z]?)\s+(.*)$", part)
                    if not mm: continue
                    code = code_norm(mm.group(1))
                    cur["courses"].append({"level": level, "semester": sem_from_code(code), "code": code, "title": title_fix(mm.group(2)), "units": None, "status": None, "legacy": True})
    elif t == "Table":
        for r in rows(b):
            if len(r) < 4: continue
            level, s, code, title = r[0], r[1], r[2], r[3]
            u = r[4] if len(r) > 4 else ""; st = r[5] if len(r) > 5 else ""
            code = code_norm(code)
            if not code or not clean(title): continue
            cur["courses"].append({
                "level": clean(level), "semester": sem(s) or (sem_from_code(code) if tier == "degree" else None),
                "code": code, "title": title_fix(title), "units": units(u), "status": clean(st) or None, "legacy": False,
            })

# GNS / Basic Science for ND have no aliases of their own in some cases -> apply to all ND rows of listed institutions
for c in curricula:
    seen = set(); keep = []
    for x in c["courses"]:
        k = (x["code"], x["level"], x["legacy"])
        if k in seen: continue
        seen.add(k); keep.append(x)
    c["courses"] = keep
curricula = [c for c in curricula if c["courses"]]
payload = {"version": 1, "source": "Nigerian_Institutions_Programme_Courses.docx (NUC CCMAS 2022/23 + BMAS, NBTE, NCCE)",
           "generatedAt": datetime.date.today().isoformat(), "curricula": curricula}
os.makedirs(os.path.dirname(out), exist_ok=True)
with gzip.open(out, "wt", encoding="utf8") as f: json.dump(payload, f, separators=(",", ":"))
n = sum(len(c["courses"]) for c in curricula)
print(f"{len(curricula)} curricula, {n} course rows, {len({(x['code'],x['title']) for c in curricula for x in c['courses']})} distinct courses -> {out}")
from collections import Counter
print(Counter(c["tier"] for c in curricula), "no-alias:", [c["name"] for c in curricula if not c["aliases"]][:10])
