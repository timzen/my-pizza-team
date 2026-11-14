/**
 * tests/e2e/model-picker-ui.test.ts — The model chip and picker in a real
 * browser (docs/DESIGN.md "Choosing a Model"; ui/src/components/team/ModelChip,
 * ui/src/components/config/AssistantSettings).
 *
 * A real daemon (tests/e2e/_sandbox.ts) serves the built UI (ui/dist — built
 * here first when it's missing or older than ui/src); the agents are scripted
 * over HTTP as a harness would be: registered with the `set-model` capability
 * and their available models, reporting session stats, and marking their
 * `set-model` directives done or failed. Playwright's Chromium (playwright-core;
 * the browser from ~/.cache/ms-playwright — the test skips without it) checks:
 *
 *   - the teammate page's chip shows the running model; picking another by
 *     keyboard creates the `set-model` directive, the chip says "switching to
 *     …" until the agent reports it done, then the new model, pinned;
 *   - with the menu open the page passes axe (WCAG 2.2 A/AA, serious or
 *     critical), and Esc closes it with focus back on the chip;
 *   - a failed switch shows the agent's reason;
 *   - the phone view's chip is read-only (no picker);
 *   - Config → General's Assistant model picker creates the leader's directive.
 */

import { test } from "node:test";
import { chromium, devices, type Page } from "playwright-core";
import { AxeBuilder } from "@axe-core/playwright";
import { assert, assertEquals } from "../_assert.ts";
import { sandbox, type Sandbox } from "./_sandbox.ts";
import { ensureUiBuilt, hasChromium } from "./_ui.ts";

const MODELS = [
  { ref: "acme/base", id: "base", name: "Acme Base", provider: "acme" },
  { ref: "acme/strong", id: "strong", name: "Acme Strong", provider: "acme" },
];

async function api(sb: Sandbox, route: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${sb.port}${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

/** Register a scripted agent that can switch models, running `model`. */
async function registerAgent(sb: Sandbox, id: string, model: (typeof MODELS)[number]): Promise<void> {
  await api(sb, "/api/agents/register", { id, name: id, directory: sb.projectDir, capabilities: ["set-model"], models: MODELS });
  await reportModel(sb, id, model);
}
const reportModel = (sb: Sandbox, id: string, m: (typeof MODELS)[number]) =>
  api(sb, `/api/agents/${id}/session-stats`, { costUsd: 0, model: { id: m.id, name: m.name, provider: m.provider } });

/** The agent's pending set-model directives. */
async function setModels(sb: Sandbox, id: string): Promise<Array<{ id: string; params: { model: string | null } }>> {
  const { directives } = await api(sb, `/api/agents/${id}/directives`);
  return directives.filter((d: { action: string }) => d.action === "set-model");
}

const chipText = (page: Page, id: string) => page.locator(`[data-model-chip="${id}"]`).innerText();

test("model chip: pick by keyboard → set-model directive → chip follows the agent", { skip: !hasChromium() && "Playwright's Chromium isn't installed", timeout: 300_000 }, async () => {
  ensureUiBuilt();
  await using sb = await sandbox("model-ui");
  sb.writeTeamConfig({ minTeammates: 0, tmuxSession: sb.session });
  await sb.startDaemon("source");
  const base = `http://127.0.0.1:${sb.port}`;
  await registerAgent(sb, "ripley", MODELS[0]!);
  await registerAgent(sb, "leader", MODELS[0]!);

  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await page.goto(`${base}/teammates/ripley`);
    const chip = page.locator(`[data-model-chip="ripley"]`);
    await chip.waitFor();
    // Page scripts are strings: this file type-checks for Node, without the DOM lib.
    await page.waitForFunction(`document.querySelector("[data-model-chip=ripley]")?.tagName === "BUTTON"`);
    assertEquals((await chipText(page, "ripley")).trim(), "Acme Base");

    // Keyboard: focus the chip, open the menu; it passes axe, and Esc gives focus back.
    await chip.focus();
    await page.keyboard.press("Enter");
    const strong = page.getByRole("menuitemradio", { name: /Acme Strong/ });
    await strong.waitFor();
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]).analyze();
    const serious = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    assertEquals(serious.map((v) => `${v.id}: ${v.nodes[0]?.target.join(" ")}`), []);
    await page.keyboard.press("Escape");
    await strong.waitFor({ state: "hidden" });
    assertEquals(await page.evaluate(`document.activeElement?.getAttribute("data-model-chip")`), "ripley");
    // …then open it again and pick Acme Strong.
    await page.keyboard.press("Enter");
    await strong.waitFor();
    await strong.focus();
    await page.keyboard.press("Enter");
    assert(await sb.waitFor(async () => (await setModels(sb, "ripley")).length === 1, 10_000), "no set-model directive");
    const [directive] = await setModels(sb, "ripley");
    assertEquals(directive!.params.model, "acme/strong");
    assert(await sb.waitFor(async () => (await chipText(page, "ripley")).includes("switching to Acme Strong"), 10_000),
      `chip while pending: ${await chipText(page, "ripley")}`);

    // The agent switches between runs and reports it: the chip shows the new model, pinned.
    await reportModel(sb, "ripley", MODELS[1]!);
    await api(sb, `/api/agents/ripley/directives/${directive!.id}`, { status: "done" }, "PUT");
    assert(await sb.waitFor(async () => (await chipText(page, "ripley")).trim() === "Acme Strong" && await chip.locator("[data-pinned]").count() === 1, 15_000),
      `chip after done: ${await chipText(page, "ripley")}`);
    assert((await chip.getAttribute("aria-label"))!.startsWith("Acme Strong (pinned)"), `${await chip.getAttribute("aria-label")}`);

    // A refused switch shows why.
    await chip.click();
    await page.getByRole("menuitemradio", { name: /Acme Base/ }).click();
    assert(await sb.waitFor(async () => (await setModels(sb, "ripley")).length === 1, 10_000), "no second directive");
    const [refused] = await setModels(sb, "ripley");
    await api(sb, `/api/agents/ripley/directives/${refused!.id}`, { status: "failed", error: "not available here" }, "PUT");
    await page.locator("#main-content").getByText("Couldn't switch to Acme Base: not available here").waitFor({ timeout: 15_000 });

    // The phone view: the same chip, read-only (and the page renders at all
    // there — no side dock for its ? button).
    const phone = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage();
    await phone.goto(`${base}/m/teammates/ripley`);
    await phone.locator(`[data-model-chip="ripley"]`).waitFor();
    assertEquals(await phone.evaluate(`document.querySelector("[data-model-chip=ripley]").tagName`), "SPAN");

    // Config → General → Assistant: the leader's model, applied at once.
    await page.goto(`${base}/config`);
    const select = page.locator("#assistant-model");
    await page.waitForFunction(`document.querySelector("#assistant-model")?.disabled === false`);
    await select.selectOption("acme/strong");
    assert(await sb.waitFor(async () => (await setModels(sb, "leader")).some((d) => d.params.model === "acme/strong"), 10_000), "no leader set-model");
    await page.locator("#main-content").getByText("Switching to Acme Strong after its current reply…").waitFor({ timeout: 10_000 });
  } finally {
    await browser.close();
  }
});
