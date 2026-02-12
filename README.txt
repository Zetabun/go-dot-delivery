Go Dot Delivery (serverless prototype)

Run locally (Windows PowerShell):
  cd "C:\Users\adamb\Desktop\go dot delivery\docs"
  py -m http.server 8000
Then open:
  http://localhost:8000/

Real-road routes (optional, one-time precompute):
  cd "C:\Users\adamb\Desktop\go dot delivery"
  py .\tools\precompute_real_routes.py

This writes:
  docs\data\edges.real.json
  docs\data\location_links.real.json

The game automatically prefers those files if present.
