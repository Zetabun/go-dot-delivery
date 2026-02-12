"""Precompute real-road polylines for Go Dot Delivery.

What this does:
- Reads:
    docs/data/hubs.json
    docs/data/edges.json
    docs/data/locations.json
- Writes:
    docs/data/edges.real.json
    docs/data/location_links.real.json

Why:
- The GAME is static (GitHub Pages / no server).
- We still want vehicles to follow real roads.
- So we generate route polylines once, offline, and ship them as JSON.

Note:
- This script uses the public OSRM demo router by default (good for prototypes).
- For scaling, swap OSRM_BASE to your own OSRM instance built from your .osm.pbf.
"""

import json
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "docs" / "data"

OSRM_BASE = "https://router.project-osrm.org"  # swap to your own router later
DELAY = 0.15  # seconds between requests


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
        "coords": r["geometry"]["coordinates"],  # [[lng,lat],...]
        "distance_m": int(round(r["distance"])),
        "duration_s": int(round(r["duration"])),
    }


def main():
    hubs = load_json(DATA / "hubs.json")["hubs"]
    edges = load_json(DATA / "edges.json")["edges"]
    locs = load_json(DATA / "locations.json")["locations"]
    hubs_by_id = {h["id"]: h for h in hubs}

    real_edges = []
    print(f"Routing {len(edges)} hub edges...")
    for i, e in enumerate(edges, 1):
        a = hubs_by_id[e["from"]]
        b = hubs_by_id[e["to"]]
        print(f"  [{i}/{len(edges)}] {e['from']} -> {e['to']}")
        try:
            r = route_osrm(a["lng"], a["lat"], b["lng"], b["lat"])
            real_edges.append(
                {
                    "from": e["from"],
                    "to": e["to"],
                    "distance_m": r["distance_m"],
                    "duration_s": r["duration_s"],
                    "polyline": r["coords"],
                }
            )
        except Exception as ex:
            print("    ERROR, keeping fallback edge:", ex)
            real_edges.append(e)
        time.sleep(DELAY)

    real_links = []
    print(f"Routing {len(locs)} location->hub links...")
    for i, loc in enumerate(locs, 1):
        hub = hubs_by_id[loc["hubId"]]
        print(f"  [{i}/{len(locs)}] {loc['id']} -> {loc['hubId']}")
        try:
            r = route_osrm(loc["lng"], loc["lat"], hub["lng"], hub["lat"])
            real_links.append(
                {
                    "from": loc["id"],
                    "to": loc["hubId"],
                    "distance_m": r["distance_m"],
                    "duration_s": r["duration_s"],
                    "polyline": r["coords"],
                }
            )
        except Exception as ex:
            print("    ERROR, using straight line:", ex)
            real_links.append(
                {
                    "from": loc["id"],
                    "to": loc["hubId"],
                    "distance_m": 0,
                    "duration_s": 0,
                    "polyline": [[loc["lng"], loc["lat"]], [hub["lng"], hub["lat"]]],
                }
            )
        time.sleep(DELAY)

    save_json(DATA / "edges.real.json", {"edges": real_edges})
    save_json(DATA / "location_links.real.json", {"links": real_links})
    print("\nDone.")
    print("Wrote docs/data/edges.real.json") 
    print("Wrote docs/data/location_links.real.json")


if __name__ == "__main__":
    main()
