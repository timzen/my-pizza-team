# Thoughts → MPT port: feature diff & bring-over plan

Comparison of the standalone **Thoughts** product (`./Thoughts`) against the
**MPT port** (`my-pizza-team` Thoughts tab). Legend:

- ✅ ported — present in MPT
- ⚠️ partial — present but thinner than the original
- ❌ missing — not ported (candidate to bring over)
- 🚫 dropped on purpose — cosmetic bulk or a deliberate design change

---

## 1. Data model & lifecycle

| Feature | Original | MPT | Notes |
|---|---|---|---|
| Note core (content/color/x/y/w/h/z/pinned/groupId) | ✅ | ✅ | |
| Storage | SQLite + JSON mirror | `thoughts/<id>.md` frontmatter | MPT is file-source-of-truth |
| `status` | active/done/archived | active/archived | 🚫 dropped `done` (checklists instead) |
| `done` auto-archive sweep + stale sweep | ✅ | 🚫 | deliberate: no auto-sweeps |
| `lastContentEditAt` ("edited" indicator) | ✅ | ❌ | minor |
| `linkedTaskId` | ✅ | 🚫 | deliberate: notes decoupled from tasks |
| `agentNote` / `agentTriagedAt` | ✅ | ❌ | triage annotations shown on a note |
| `agentSuggestion` chips (promote/archive/cron/lesson) + accept/dismiss | ✅ | ⚠️ | assistant now *writes* the board via tools instead of chip UI |
| Events/audit (`/thoughts/:id/events`) | ✅ | ❌ | deferred; pairs with scheduled triage |
| Group `plateOpacity` | ✅ | ❌ | |
| Group `groupColor` (manual tint) | ✅ | ❌ | |
| Group `collapsed` (stack) | ✅ (reserved) | ❌ | |
| Group geometry (own x/y/w/h) | ❌ (bbox only) | ✅ | MPT *added* movable/resizable plates |

## 2. Canvas interactions

| Feature | Original | MPT | Notes |
|---|---|---|---|
| Pan / zoom (wheel) / drag / resize | ✅ | ✅ | |
| Zoom −/＋/reset buttons | ✅ | ✅ | |
| Shift-click multi-select | ✅ | ✅ | |
| Marquee drag-select | ✅ | ⚠️ | MPT requires **shift+drag** (plain drag pans); original has an explicit **select-mode toggle** (S / lasso button) so plain drag marquees |
| Group from selection | ✅ (G key) | ✅ (Group button) | no keyboard `G` in MPT |
| Multi-note drag (move whole selection) | ✅ | ❌ | MPT drags one note; plates carry members, but a free multi-select drag doesn't |
| Group membership | spatial + menu | menu only | MPT sets membership via the note's Group menu |
| Auto-arrange / Tidy | ⚠️ (limited) | ✅ | MPT *added* Tidy (grid per group + ungrouped) |
| Keyboard shortcuts (Esc, Cmd+0/=/−, 1–6 recolor, S, M, G, Delete, E/F expand, I inspect) | ✅ | ❌ | MPT only has textarea Esc/Cmd+Enter |
| Markdown editor shortcuts (bold/italic/list in editor) | ✅ (`markdownShortcuts`) | ❌ | |
| Content clamp (truncate long notes w/ expand) | ✅ (`contentClamp`) | ❌ | MPT renders full content |
| Auto-rotate new-note color | ✅ (`autoRotate`) | ❌ | MPT defaults yellow |
| Pan bounds from note extent | ✅ (`notesExtent`) | ❌ | MPT pans infinitely |
| Interactive GFM checklists in notes | ❌ | ✅ | MPT *added* |
| Copy note/group id | ⚠️ (CopyableId) | ✅ | |

## 3. Panels & chrome

| Feature | Original | MPT | Notes |
|---|---|---|---|
| Minimap (M key, always-on pin) | ✅ | ❌ | `ThoughtMinimap` (532 lines) |
| Command palette (Cmd/K fuzzy search + jump) | ✅ | ❌ | `CommandPalette` |
| Expanded / focused note view (E/F) | ✅ | ❌ | `ThoughtExpanded` (598 lines) |
| Note overflow context menu (⋯) | ✅ | ⚠️ | MPT has a hover toolbar, no overflow menu |
| Shortcuts help panel (?) | ✅ | ❌ | `ShortcutsPanel` |
| Archived drawer | ✅ | ✅ | |
| Floating toolbar HUD | ✅ | ⚠️ | MPT has a simple top-left toolbar |

## 4. Cosmetic surface (🚫 intentionally dropped)

The bulk of the original UI (~5–6k lines). Not recommended to bring over.

- `BoardSettingsPanel` (1,566 lines) — the whole settings surface
- 100+ backgrounds/patterns (`patternMotifs`, `patternTiles`, `gridStyle`, `PatternCatalogPopover`)
- Skins + zoom atmosphere (`skinPresets`, `zoomAtmosphere`)
- Palette editor + custom colors (`PalettePickerPopover`, `customColors`, `colorField`, `activePalette`, `plateTint`, `plateColor`)
- Canvas tint, grid opacity/color, text-size, min-note presets

## 5. Agent / triage integration

| Feature | Original | MPT | Notes |
|---|---|---|---|
| Agent reads the board | MCP (8 tools) | ✅ | `list_thoughts` / `get_thought` / `list_thought_groups` |
| Agent writes the board | MCP | ✅ | `create_thought` / `edit_thought` / `archive_thought` / `group_thoughts` |
| Suggestion chips on notes (accept/dismiss) | ✅ | ❌ | replaced by direct assistant writes |
| Agent Runs ledger (`/api/agent-runs`) | ✅ | ❌ | pairs with scheduled triage |
| Triage timing helpers (`triageTime`, `statusLabels`) | ✅ | ❌ | |

---

## Recommended bring-over plan

**Tier 1 — high value, low cost (real UX gaps):**
1. **Select-mode toggle** (lasso button + `S` key) so plain drag marquees — this is almost certainly the "lost drag-to-select" (today it needs shift+drag, undiscoverable).
2. **Core keyboard shortcuts:** `Delete`→archive, `1–6`→recolor, `G`→group selection, `Cmd/Ctrl 0/=/−`→zoom/reset, `Esc`→clear selection.
3. **Multi-note drag** — dragging any selected note moves the whole selection.

**Tier 2 — meaningful, medium cost:**
4. **Minimap** (`M` toggle) — orientation on a big board.
5. **Expanded note view** (`E`/`F`) — a roomy editor for long notes + markdown editor shortcuts.
6. **Content clamp** — truncate tall notes in-place with a click-to-expand, so the board stays scannable.

**Tier 3 — organization polish:**
7. **Note overflow (⋯) menu** — fold color/group/pin/archive/delete + copy-id into one tidy menu.
8. **Group tint / opacity** (`groupColor`, `plateOpacity`) — visually distinguish groups.
9. **Auto-rotate new-note color.**

**Tier 4 — deferred until there's a consumer:**
10. **Events/audit** + **Agent Runs ledger** — bring these together with a **scheduled-triage** persona (they exist to give a triage agent memory).

**Skip (🚫):** the entire cosmetic settings surface, `done` state + auto-sweeps, `linkedTaskId`, suggestion chips (superseded by assistant write tools).
