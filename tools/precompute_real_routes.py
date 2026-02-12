import json
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "docs" / "data"

OSRM_BASE = "https://router.project-osrm.org"
DELAY = 0.15  # seconds between requests (be polite)

def load_json(p: Path):
    with p.open("r", encoding="utf-8") as f:
        return json.load(f)

def save_json(p: Path, obj):
    with p.open("w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2)

def route_osrm(a_lng, a_lat, b_lng, b_lat):
    url = (
        f"{OSRM_BASE}/route/v1/driving/"
        f"{a_lng},{a_lat};{b_lng},{b_lat}"
        f"?overview=full&geometries=geojson"
    )
    with urllib.request.urlopen(url) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    r = data["routes"][0]
    return {
        "coords": r["geometry"]["coordinates"],
        "distance_m": int(round(r["distance"])),
        "duration_s": int(round(r["duration"]))
    }

def fmt_time(seconds: float) -> str:
    seconds = max(0, int(seconds))
    m, s = divmod(seconds, 60)
    h, m = divmod(m, 60)
    if h:
        return f"{h}h {m}m {s}s"
    if m:
        return f"{m}m {s}s"
    return f"{s}s"

def progress(done: int, total: int, start_ts: float, label: str):
    now = time.time()
    elapsed = now - start_ts
    rate = done / elapsed if elapsed > 0 else 0
    remaining = (total - done) / rate if rate > 0 else 0
    pct = (done / total) * 100 if total else 100

    bar_len = 28
    filled = int(bar_len * done / total) if total else bar_len
    bar = "█" * filled + "░" * (bar_len - filled)

    print(
        f"\r[{bar}] {pct:6.2f}%  {done}/{total}  "
        f"elapsed {fmt_time(elapsed)}  ETA {fmt_time(remaining)}  "
        f"{label[:60]:60}",
        end="",
        flush=True
    )

def main():
    hubs = load_json(DATA / "hubs.json")["hubs"]
    edges = load_json(DATA / "edges.json")["edges"]
    locs = load_json(DATA / "locations.json")["locations"]

    hubs_by_id = {h["id"]: h for h in hubs}

    total_steps = len(edges) + len(locs)
    done_steps = 0
    start_ts = time.time()

    real_edges = []
    print(f"Precomputing real polylines using OSRM: {OSRM_BASE}")
    print(f"Total tasks: {total_steps} ({len(edges)} edges + {len(locs)} location links)\n")

    # ---- Hub edges ----
    for i, e in enumerate(edges, 1):
        a = hubs_by_id[e["from"]]
        b = hubs_by_id[e["to"]]
        label = f"EDGE {i}/{len(edges)}  {e['from']} -> {e['to']}"
        try:
            r = route_osrm(a["lng"], a["lat"], b["lng"], b["lat"])
            real_edges.append({
                "from": e["from"],
                "to": e["to"],
                "distance_m": r["distance_m"],
                "duration_s": r["duration_s"],
                "polyline": r["coords"]
            })
        except Exception:
            # Fallback to original edge if routing fails
            real_edges.append(e)

        done_steps += 1
        progress(done_steps, total_steps, start_ts, label)
        time.sleep(DELAY)

    # newline after progress bar line
    print()

    # ---- Location -> hub links ----
    real_links = []
    for i, loc in enumerate(locs, 1):
        hub = hubs_by_id[loc["hubId"]]
        label = f"LINK {i}/{len(locs)}  {loc['id']} -> {loc['hubId']}"
        try:
            r = route_osrm(loc["lng"], loc["lat"], hub["lng"], hub["lat"])
            real_links.append({
                "from": loc["id"],
                "to": loc["hubId"],
                "distance_m": r["distance_m"],
                "duration_s": r["duration_s"],
                "polyline": r["coords"]
            })
        except Exception:
            # Straight line fallback
            real_links.append({
                "from": loc["id"],
                "to": loc["hubId"],
                "distance_m": 0,
                "duration_s": 0,
                "polyline": [[loc["lng"], loc["lat"]], [hub["lng"], hub["lat"]]]
            })

        done_steps += 1
        progress(done_steps, total_steps, start_ts, label)
        time.sleep(DELAY)

    print("\n\nWriting output files...")

    save_json(DATA / "edges.real.json", {"edges": real_edges})
    save_json(DATA / "location_links.real.json", {"links": real_links})

    print("✅ Done.")
    print(f" - {DATA / 'edges.real.json'}")
    print(f" - {DATA / 'location_links.real.json'}")

if __name__ == "__main__":
    main()
