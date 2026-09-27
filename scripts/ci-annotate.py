#!/usr/bin/env python3
"""
scripts/ci-annotate.py — turn failed `deno test` output into GitHub annotations.

Job logs need authentication to read; annotations don't, and GitHub also shows them
inline on pull requests. Without this, a failing CI run says only "exit code 1" to
anyone outside the repo's collaborators — which is how the first e2e failure had to be
diagnosed by guessing at environment differences.

Reads `deno test` output (NO_COLOR) on stdin and prints one `::error` per failed test
with its assertion message. GitHub caps annotations per step, so only the first few
are emitted; the rest are summarised in one line.
"""
import re
import sys

MAX = 8
text = sys.stdin.read()
section = text.split("ERRORS", 1)[1] if "ERRORS" in text else ""
section = section.split("FAILURES", 1)[0]

failures = []
current = None
for line in section.splitlines():
    header = re.match(r"^(.+?) => (\S+?):(\d+):\d+\s*$", line.strip())
    if header:
        current = {"name": header.group(1), "file": header.group(2).lstrip("./"), "line": header.group(3), "msg": []}
        failures.append(current)
    elif current is not None and line.strip() and len(current["msg"]) < 6:
        current["msg"].append(line.strip())

def esc(s: str) -> str:
    return s.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")

for f in failures[:MAX]:
    msg = " | ".join(f["msg"]) or "failed"
    print(f"::error file={f['file']},line={f['line']},title={esc(f['name'])}::{esc(msg)}")
if len(failures) > MAX:
    print(f"::error::{len(failures) - MAX} more failing test(s) not shown")
if not failures and "FAILED" in text:
    # Failed before any test ran (e.g. a type error): surface the first error line.
    first = next((l for l in text.splitlines() if l.startswith("error")), "deno test failed")
    print(f"::error::{esc(first)}")
