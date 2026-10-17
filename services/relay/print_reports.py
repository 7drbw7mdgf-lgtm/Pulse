"""Format `wrangler d1 execute --json` output of the reports table (used by reports.sh)."""
import json
import sys

rows = json.load(sys.stdin)[0]['results']
if not rows: print('No reports.')
for row in rows:
    body = json.loads(row['body'])
    print(f"{row['sent']}  {row['version']}  {row['kind']}  {body.get('errorType')}: {body.get('message')}")
    for frame in body.get('frames', [])[-6:]: print('      ', frame)
