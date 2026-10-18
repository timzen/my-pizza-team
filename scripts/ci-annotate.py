#!/usr/bin/env python3
"""
scripts/ci-annotate.py — turn failed `node --test` output into GitHub annotations.

Job logs need authentication to read; annotations don't, and GitHub also shows them
inline on pull requests. Without this, a failing CI run says only "exit code 1" to
anyone outside the repo's collaborators — which is how the first e2e failure had to be
diagnosed by guessing at environment differences.

Reads the `spec` reporter's output (node:test's default; run with NO_COLOR) on stdin
and prints one `::error` per failed test with its assertion message. The spec reporter
ends with a "failing tests:" summary, one entry per failure:

    test at tests/store.test.ts:12:1
    ✖ the test's name (1.2ms)
      AssertionError [ERR_ASSERTION]: the message
      ...
          at TestContext.<anonymous> (file:///.../tests/store.test.ts:14:3)

GitHub caps annotations per step, so only the first few are emitted; the rest are
summarised in one line.
"""
import re
import sys

MAX = 8
MSG_LINES = 6
text = sys.stdin.read()
lines = text.splitlines()

# Only the summary: the same failures are printed inline earlier, with less structure.
start = next((i for i, l in enumerate(lines) if l.startswith("✖ failing tests:")), len(lines))
summary = lines[start + 1:]

failures = []
current = None
for line in summary:
    where = re.match(r"^test at (.+?):(\d+):\d+\s*$", line)
    if where:
        current = {"file": where.group(1).lstrip("./"), "line": where.group(2), "name": None, "msg": [], "done": False}
        failures.append(current)
        continue
    if current is None:
        continue
    if current["name"] is None:
        title = re.match(r"^✖ (.*?)(?: \([\d.]+m?s\))?\s*$", line)
        if title:
            current["name"] = title.group(1)
        continue
    # The message runs until the stack trace (or the error's property dump) starts.
    stripped = line.strip()
    if current["done"] or not stripped:
        continue
    if stripped.startswith("at ") or stripped.endswith("{") and len(current["msg"]) > 0:
        current["done"] = True
        continue
    if len(current["msg"]) < MSG_LINES:
        current["msg"].append(stripped)


def load_error(file: str) -> str | None:
    """A file that failed to load reports only 'test failed'; find its error in stderr."""
    for i, l in enumerate(lines[:start]):
        if file in l and l.startswith("file://"):
            for nxt in lines[i + 1:i + 8]:
                if re.match(r"^\w*Error\b", nxt):
                    return nxt.strip()
    return None


def esc(s: str) -> str:
    return s.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def esc_prop(s: str) -> str:
    return esc(s).replace(":", "%3A").replace(",", "%2C")


for f in failures[:MAX]:
    msg = " | ".join(f["msg"]) or "failed"
    if msg.strip("'") == "test failed":
        msg = load_error(f["file"]) or "the test file failed (it did not load, or exited early)"
    name = f["name"] or "test failed"
    print(f"::error file={f['file']},line={f['line']},title={esc_prop(name)}::{esc(msg)}")
if len(failures) > MAX:
    print(f"::error::{len(failures) - MAX} more failing test(s) not shown")
if not failures:
    # Failed before any test ran (e.g. npm couldn't start node): surface the first error line.
    first = next((l for l in lines if re.search(r"\bError\b|^npm (ERR|error)", l)), "node --test failed")
    print(f"::error::{esc(first.strip())}")
