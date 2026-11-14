/**
 * tests/model-picker-ui.test.ts — The UI's model chip and picker (docs/DESIGN.md
 * "Choosing a Model"): what ui/src/lib/models.ts says about an agent's model
 * state — the effective model, a pin, a failover substitute, a switch pending
 * or failed, "not supported by this harness" — and where the chip lives (the
 * teammate page's header and the Assistant card; never the Team tab's rows).
 * The fast suite has no DOM, so placement is checked in the source; the
 * rendered chip is covered by tests/e2e/model-picker-ui.test.ts.
 */

import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { assert, assertEquals, assertStringIncludes } from "./_assert.ts";
import { applyToAllModel, changeOutcome, currentRef, failoverActive, modelChipView, modelChoicesByHarness, modelLabel, sessionModelRef } from "../ui/src/lib/models.ts";
import type { AgentModelResponse, ModelChangeView } from "../shared/protocol.ts";

const MODELS = [
  { ref: "acme/fast", id: "fast", name: "Acme Fast", provider: "acme" },
  { ref: "acme/strong", id: "strong", name: "Acme Strong", provider: "acme" },
];
const CURRENT = { id: "fast", name: "Acme Fast", provider: "acme" };

function change(over: Partial<ModelChangeView>): ModelChangeView {
  return { id: "d1", model: "acme/strong", source: "user", status: "done", error: null, createdAt: "", updatedAt: "", ...over };
}
function state(over: Partial<AgentModelResponse> = {}): AgentModelResponse {
  return { supported: true, models: MODELS, pin: null, current: CURRENT, lastChange: null, ...over };
}

test("refs and labels: provider/id, the reported name, else the ref", () => {
  assertEquals(sessionModelRef(CURRENT), "acme/fast");
  assertEquals(sessionModelRef({ id: "solo", provider: "" }), "solo");
  assertEquals(modelLabel("acme/strong", MODELS), "Acme Strong");
  assertEquals(modelLabel("other/x", MODELS), "other/x");
  assertEquals(modelLabel(null, MODELS), "its default model");
});

test("modelChipView: the running model, unpinned, changeable", () => {
  const v = modelChipView(state(), null);
  assertEquals(v.label, "Acme Fast");
  assertEquals(v.pinned, false);
  assertEquals(v.failover, false);
  assertEquals(v.changeable, true);
  assertStringIncludes(v.tooltip, "Model: acme/fast");
  assertStringIncludes(v.tooltip, "Not pinned");
});

test("modelChipView: a pin is marked and explained", () => {
  const v = modelChipView(state({ pin: "acme/strong", current: { id: "strong", name: "Acme Strong", provider: "acme" } }), null);
  assertEquals(v.pinned, true);
  assertEquals(v.label, "Acme Strong");
  assertStringIncludes(v.tooltip, "Pinned by you: Acme Strong");
});

test("modelChipView: pending, failed, and an active failover substitute", () => {
  assertEquals(modelChipView(state({ lastChange: change({ status: "pending" }) }), null).pending, "Acme Strong");
  const failed = modelChipView(state({ lastChange: change({ status: "failed", error: "isn't a model this Pi knows" }) }), null);
  assertEquals(failed.failed, "isn't a model this Pi knows");
  assertStringIncludes(failed.tooltip, "failed: isn't a model this Pi knows");
  const fo = modelChipView(state({ lastChange: change({ source: "failover", reason: "throttled" }) }), null);
  assertEquals(fo.failover, true);
  assertStringIncludes(fo.tooltip, "Failover: using Acme Strong instead of its usual model — throttled");
  // A failover that cleared its substitute (model null) is no longer in effect.
  assertEquals(failoverActive(change({ source: "failover", model: null })), false);
  assertEquals(failoverActive(change({ source: "failover", status: "pending" })), false);
});

test("modelChipView: an old harness is read-only and says why; before load, the session's model", () => {
  const old = modelChipView(state({ supported: false, models: null }), null);
  assertEquals(old.changeable, false);
  assertStringIncludes(old.tooltip, "not supported by this harness");
  assertEquals(modelChipView(state({ models: [] }), null).changeable, false);
  const loading = modelChipView(null, CURRENT);
  assertEquals(loading.label, "Acme Fast");
  assertEquals(loading.changeable, false);
});

test("changeOutcome: only the asked directive, once it's no longer pending", () => {
  assertEquals(changeOutcome(change({ status: "pending" }), "d1"), null);
  assertEquals(changeOutcome(change({}), "other"), null);
  assertEquals(changeOutcome(change({}), "d1"), { done: true });
  assertEquals(changeOutcome(change({ status: "failed", error: "nope" }), "d1"), { error: "nope" });
  assertEquals(changeOutcome(change({ status: "cancelled", error: null }), "d1"), { error: "superseded by a newer change" });
});

test("applyToAllModel / currentRef: the pin, else the running model's ref", () => {
  assertEquals(applyToAllModel(state({ pin: "acme/strong" })), "acme/strong");
  assertEquals(applyToAllModel(state()), "acme/fast");
  assertEquals(applyToAllModel(state({ current: null })), null);
  assertEquals(applyToAllModel(state({ current: { id: "gone", name: "Gone", provider: "x" } })), null);
  assertEquals(currentRef(state()), "acme/fast");
  assertEquals(currentRef(null), null);
});

test("placement: the chip is on the teammate page and the Assistant card, not the Team tab's rows", () => {
  const read = (p: string) => fs.readFileSync(path.resolve(import.meta.dirname, "..", p), "utf8");
  assertStringIncludes(read("ui/src/pages/TeammatePage.tsx"), "<ModelChip agent={agent} readOnly={phone} />");
  assert(!read("ui/src/components/team/TeamParts.tsx").includes("ModelChip"), "no picker on the Team tab's rows");
  assertStringIncludes(read("ui/src/components/config/AssistantSettings.tsx"), "<AssistantModelSetting />");
  const chip = read("ui/src/components/team/ModelChip.tsx");
  assert(chip.includes("aria-label={`${chipName(view, pending)}: change ${agent.name}'s model`}"), "the trigger is named, visible text first");
  assert(chip.includes("<FormError"), "a failed switch is shown and announced");
});

test("modelChoicesByHarness: the live agents' models per harness, deduped by ref, sorted by name", () => {
  const byHarness = modelChoicesByHarness([
    { status: "idle", harness: "pi", models: [MODELS[1]!, MODELS[0]!] },
    { status: "working", models: [MODELS[0]!, { ref: "acme/mid", id: "mid", name: "Acme Mid", provider: "acme" }] }, // no harness = pi
    { status: "offline", harness: "pi", models: [{ ref: "gone/x", id: "x", name: "Gone", provider: "gone" }] },
    { status: "idle", harness: "kiro", models: null },
    { status: "idle", harness: "claude", models: [{ ref: "c", id: "c", name: "C", provider: "" }] },
  ]);
  assertEquals([...byHarness.keys()], ["pi", "claude"]);
  assertEquals(byHarness.get("pi")!.map((m) => m.ref), ["acme/fast", "acme/mid", "acme/strong"]);
  assertEquals(modelChoicesByHarness(null).size, 0);
});
