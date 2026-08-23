#!/usr/bin/env bash
# Full verification for LifelogOS. From the repo root: bash tests/run.sh
# Exits non-zero if any harness fails or if a secret is found in the public repo.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$here/.."
rc=0

echo "===== backend.test.js ====="
node "$here/backend.test.js" || rc=1

echo; echo "===== hud.test.js ====="
node "$here/hud.test.js" || rc=1

echo; echo "===== node --check index.html inline script ====="
node -e '
  const fs=require("fs"), p=require("path");
  const html=fs.readFileSync(p.join(process.argv[1],"index.html"),"utf8");
  const m=[...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(x=>x[1]).sort((a,b)=>b.length-a.length);
  const js=m[0];
  new Function(js); // parse-check only (does not execute; DOM refs are fine to parse)
  // el() ref integrity — quote-anchored so function params like rangeLabel(start) are not mistaken for refs
  const refs=new Set([...js.matchAll(/el\(["\x27]([A-Za-z0-9_]+)["\x27]\)/g)].map(x=>x[1]));
  const ids=new Set([...html.matchAll(/id="([A-Za-z0-9_]+)"/g)].map(x=>x[1]));
  const missing=[...refs].filter(r=>!ids.has(r));
  if(missing.length){ console.log("  FAIL missing el() targets:",missing); process.exit(1); }
  console.log("  ok   inline script parses; all "+refs.size+" el() refs resolve to DOM ids");
' "$repo" || rc=1

echo; echo "===== secrets scan (public repo must carry no token or /exec URL) ====="
# a real deployment id under macros/s/ (the literal "..." placeholder in the input is allowed)
hits=$(grep -rInE 'script\.google\.com/macros/s/(\.\.\.)?[A-Za-z0-9_-]{6,}' "$repo" \
        | grep -vE 'macros/s/\.\.\./exec' || true)
# a long UUID/hex that looks like a shared secret
hits+=$(grep -rInE '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' "$repo" || true)
# an assigned token literal
hits+=$(grep -rInE '(LIFELOG_TOKEN|token)\s*[:=]\s*["'"'"'][A-Za-z0-9_-]{12,}' "$repo" || true)
if [ -n "$hits" ]; then echo "  FAIL possible secret committed:"; echo "$hits"; rc=1;
else echo "  ok   no /exec URL, token, or UUID secret in $repo"; fi

echo; if [ "$rc" -eq 0 ]; then echo "ALL GREEN"; else echo "FAILURES ABOVE"; fi
exit $rc
