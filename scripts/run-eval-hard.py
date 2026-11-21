"""The harder-pictures test of Adds Up. Added at the event on 2026-11-21, after the 50-filing test.

The 50-filing test used clean pictures, and one plain model call read them as well as Adds Up.
This test asks what happens when the picture gets worse. For each filing it makes three copies
of the statement picture, each worse than the last, and reads each copy two ways:
  - one plain Hydrogen call, where every number it returns counts as "shown as right";
  - Adds Up's upload path, where a number gets a tick only inside a total that re-adds.
Level 1 is step F of docs/eval-spec.md (turned 2 degrees, blur 1.2). Levels 2 and 3 are new.

Since the second-reader rule, the upload path reads each picture with two models, and the
result counts how many pages the second reader answered and how many cells the two disagreed on.

Run from the repository root with the app running:
  uv run --with pillow --with google-genai python scripts/run-eval-hard.py <log.jsonl> <out.json>
"""
import base64, io, json, os, random, re, subprocess, sys, time, urllib.request, uuid
from PIL import Image, ImageFilter
from google import genai

APP = os.environ.get("EVAL_APP", "http://localhost:3230")
ALL_LEVELS = [
    ("1", "turned 2 degrees, slight blur", dict(scale=1.0, turn=2, blur=1.2, jpeg=None, noise=0)),
    ("2", "like a phone photo: smaller, turned 3 degrees, blurred, compressed", dict(scale=0.55, turn=3, blur=1.6, jpeg=30, noise=6)),
    ("3", "like a bad phone photo: much smaller, turned 5 degrees, more blur and compression", dict(scale=0.40, turn=5, blur=2.2, jpeg=18, noise=10)),
]
PROMPT = "\n".join([
    "Read every printed row in this balance sheet picture that has a number, a dash, or a black covered box.",
    "Output one line per row in the exact printed order, using this format:",
    "label | left value | right value",
    "",
    "Rules:",
    "- Write each number exactly as printed, including dollar signs, commas, and brackets or parentheses.",
    "- Leave a cell empty where the page shows nothing.",
    "- If a cell is covered by a black box, write HIDDEN for that cell.",
    "- Do not include section headings that have no numbers or dashes.",
    "- Output only the row lines, with no extra text.",
])
# EVAL_LEVELS=1,2 runs only those levels.
LEVELS = [lv for lv in ALL_LEVELS if lv[0] in os.environ.get("EVAL_LEVELS", "1,2,3").split(",")]
client = genai.Client(http_options={"api_version": "v1beta"})


def get(url, data=None, headers=None, timeout=150):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method="POST" if data is not None else "GET")
    return urllib.request.urlopen(req, timeout=timeout).read()


def to_number(raw):
    t = re.sub(r"[$,\s]", "", raw or "")
    if not t or re.fullmatch(r"[-–—]+", t):
        return None
    neg = t.startswith("(") or t.startswith("-")
    try:
        v = float(t.strip("()-"))
    except ValueError:
        return float("nan")
    return -v if neg else v


def worsen(png, scale, turn, blur, jpeg, noise, seed):
    im = Image.open(io.BytesIO(png)).convert("RGB")
    if scale != 1.0:
        im = im.resize((int(im.width * scale), int(im.height * scale)), Image.LANCZOS)
    im = im.rotate(-turn, resample=Image.BICUBIC, expand=True, fillcolor="white").filter(ImageFilter.GaussianBlur(blur))
    if noise:
        rnd = random.Random(seed)
        px = im.load()
        for _ in range(im.width * im.height // 12):
            x, y = rnd.randrange(im.width), rnd.randrange(im.height)
            d = rnd.randint(-noise * 4, noise * 4)
            px[x, y] = tuple(max(0, min(255, c + d)) for c in px[x, y])
    out = io.BytesIO()
    if jpeg:
        im.save(out, "JPEG", quality=jpeg)
        return out.getvalue(), "image/jpeg", "jpg"
    im.save(out, "PNG")
    return out.getvalue(), "image/png", "png"


key = lambda s: re.sub(r"[^a-z0-9]", "", s.lower())


def align(truth_rows, read_rows):
    """Pairs each true number row with a read row by its label, in order. Returns [(truth, read or None)]."""
    pairs, j = [], 0
    for tr in truth_rows:
        f = next((k for k in range(j, min(len(read_rows), j + 4)) if key(read_rows[k][0]) == key(tr["label"])), -1)
        if f >= 0:
            j = f + 1
        pairs.append((tr, read_rows[f] if f >= 0 else None))
    return pairs


def one_call(data, mime):
    r = client.interactions.create(
        model="gemini-4-hydrogen",
        input=[{"type": "image", "data": base64.b64encode(data).decode(), "mime_type": mime, "resolution": "high"}, {"type": "text", "text": PROMPT}],
        generation_config={"thinking_level": "low"},
    )
    rows = []
    for line in (r.output_text or "").splitlines():
        parts = [p.strip() for p in line.split("|")]
        if len(parts) >= 3:
            rows.append(("|".join(parts[:-2]), to_number(parts[-2]), to_number(parts[-1])))
    return rows


def adds_up(data, mime, ext):
    boundary = uuid.uuid4().hex
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"statement.{ext}\"\r\nContent-Type: {mime}\r\n\r\n").encode() + data + f"\r\n--{boundary}--\r\n".encode()
    cookie = "adds_up_browser=hard-" + uuid.uuid4().hex
    up = json.loads(get(APP + "/api/upload", body, {"Content-Type": "multipart/form-data; boundary=" + boundary, "Cookie": cookie}))
    events = [json.loads(l) for l in get(APP + f"/api/upload/{up['id']}/read", b"", {"Cookie": cookie}).decode().splitlines() if l.strip().startswith("{")]
    done = next((e for e in events if e.get("type") == "done"), None)
    if not done:
        return None, (events[-1].get("type") if events else "no answer"), None
    return [(r["label"], r["cells"][0].get("number"), r["cells"][1].get("number")) for r in done["result"]["rows"]], "read", done["result"].get("crossCheck")


def ticks(rows):
    out = subprocess.run(["node", "scripts/prove-cells.mjs"], input=json.dumps({"left": [r[1] for r in rows], "right": [r[2] for r in rows]}), capture_output=True, text=True, check=True)
    return json.loads(out.stdout.strip().splitlines()[-1])


def same(a, b):
    return a is not None and b is not None and a == a and abs(a - b) < 1e-6


def main():
    filings = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
    result = {"startedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "filings": len(filings), "levels": [], "cases": []}
    totals = {lv[0]: {"level": lv[0], "what": lv[1], "numbers": 0,
                      "oneCall": {"right": 0, "wrongShownAsRight": 0, "notRead": 0},
                      "addsUp": {"right": 0, "wrongWithATick": 0, "wrongNoTick": 0, "notRead": 0, "ticks": 0, "pagesNotRead": 0,
                                 "pages": 0, "secondReaderAnswered": 0, "cellsTheTwoReadersDisagreedOn": 0}} for lv in LEVELS}
    for n, f in enumerate(filings, 1):
        st = json.loads(get(APP + f"/api/company/{f['cik']}/statement"))["statement"]
        truth = [r for r in st["rows"] if "values" in r]
        png = get(APP + f"/api/company/{f['cik']}/picture")
        for level, what, opts in LEVELS:
            data, mime, ext = worsen(png, seed=int(f["cik"]) + int(level), **opts)
            t = totals[level]
            try:
                base = one_call(data, mime)
            except Exception as e:
                base = []
            read, state, cross = adds_up(data, mime, ext)
            t["addsUp"]["pages"] += 1
            if cross and cross.get("answered"):
                t["addsUp"]["secondReaderAnswered"] += 1
                t["addsUp"]["cellsTheTwoReadersDisagreedOn"] += cross.get("disputedCount", 0)
            status = ticks(read) if read else None
            if not read:
                t["addsUp"]["pagesNotRead"] += 1
            bp = align(truth, base)
            ap = align(truth, read or [])
            read_index = {id(r): i for i, r in enumerate(read or [])}
            for (tr, b), (_, a) in zip(bp, ap):
                for c in (0, 1):
                    tv = to_number(tr["values"][c])
                    if tv is None:
                        continue
                    t["numbers"] += 1
                    bv = b[c + 1] if b else None
                    if bv is None: t["oneCall"]["notRead"] += 1
                    elif same(bv, tv): t["oneCall"]["right"] += 1
                    else:
                        t["oneCall"]["wrongShownAsRight"] += 1
                        result["cases"].append({"company": f["company"], "level": level, "who": "one call", "row": tr["label"], "truth": tv, "read": bv})
                    av = a[c + 1] if a else None
                    ticked = bool(a) and status[("left", "right")[c]][read_index[id(a)]] == "proven"
                    if ticked: t["addsUp"]["ticks"] += 1
                    if av is None: t["addsUp"]["notRead"] += 1
                    elif same(av, tv): t["addsUp"]["right"] += 1
                    elif ticked:
                        t["addsUp"]["wrongWithATick"] += 1
                        result["cases"].append({"company": f["company"], "level": level, "who": "Adds Up, with a tick", "row": tr["label"], "truth": tv, "read": av})
                    else:
                        t["addsUp"]["wrongNoTick"] += 1
                        result["cases"].append({"company": f["company"], "level": level, "who": "Adds Up, no tick", "row": tr["label"], "truth": tv, "read": av})
            print(f"[{n}/{len(filings)}] {f['company'][:30]} level {level}: one call wrong {t['oneCall']['wrongShownAsRight']}, Adds Up wrong with a tick {t['addsUp']['wrongWithATick']}, wrong without a tick {t['addsUp']['wrongNoTick']} (running totals)", flush=True)
        result["levels"] = list(totals.values())
        json.dump(result, open(sys.argv[2], "w"), indent=1)
    result["finishedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    json.dump(result, open(sys.argv[2], "w"), indent=1)
    print(json.dumps(result["levels"], indent=1))


main()
