/**
 * App.tsx — Root application component with routing and layout.
 *
 * Two full-height columns with aligned h-14 headers: the **SideDock** on the
 * left (tabs: the Assistant chat, and the Team — agents + live queue — plus
 * quick-create; collapses to an icon rail) and the center (nav + routed page).
 * The **NavBar spans only the center column**: it navigates the center, and the
 * dock is independent of it (DESIGN.md "The Shell: a Dock and a Center").
 *
 * `/m` and below is a different shell altogether — the phone view
 * (mobile/MobileShell, docs/DESIGN.md "A Phone Is a Peek"). The split happens
 * before either shell mounts, so the phone never mounts the dock (a second chat
 * stream, and the floating panel over everything), and a phone landing on the
 * home page is sent to `/m` before the desktop shell renders.
 *
 * Pages of a work-item kind the team switched off (docs/DESIGN.md "Feature
 * Toggles") are wrapped in a FeatureRoute, which shows a "turned off" notice
 * instead. `/work-defs/:id` isn't wrapped: its kind is only known once loaded,
 * so the page itself shows the notice on the daemon's 403.
 *
 * Context and Workflows are tabs of the Config page (`/config/context`,
 * `/config/workflows[/:name]`); their old top-level URLs redirect there with
 * `replace` (lib/config-tabs.ts `legacyConfigPath`).
 *
 * Board, Tasks, and Schedule are sub-tabs of **Work Items** (`/work-items/board
 * |tasks|schedule|pending|archived`, lib/work-items.ts); `/work-items` lands on
 * the first enabled tab. Their old top-level URLs (`/board`, `/tasks`,
 * `/schedule`, `/pending`, `/backlog`, `/archived`) redirect there with
 * `replace`. Templates are hidden from the UI (being deprecated — the daemon's
 * template API and data are untouched); `/templates[/:id]` redirects to Tasks.
 */

import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { legacyConfigPath } from "./lib/config-tabs";
import { defaultWorkItemsPath, legacyWorkItemsPath } from "./lib/work-items";
import { useFeatures } from "./hooks/useFeatures";
import { NavBar } from "./components/NavBar";
import { SideDock } from "./components/dock/SideDock";
import { SideDockProvider, OpenAssistantTab } from "./components/dock/SideDockProvider";
import { RootPage } from "./pages/RootPage";
import { ThoughtsPage } from "./pages/ThoughtsPage";
import { TriagePage } from "./pages/TriagePage";
import { BoardPage } from "./pages/BoardPage";
import { TaskDetailPage } from "./pages/TaskDetailPage";
import { StoryDetailPage } from "./pages/StoryDetailPage";
import { TasksPage } from "./pages/TasksPage";
import { SchedulePage } from "./pages/SchedulePage";
import { NewWorkDefPage } from "./pages/NewWorkDefPage";
import { WorkDefDetailPage } from "./pages/WorkDefDetailPage";
import { LifecyclePage } from "./pages/LifecyclePage";
import { NewStoryPage } from "./pages/NewStoryPage";
import { NewTaskPage } from "./pages/NewTaskPage";
import { ConfigPage } from "./pages/ConfigPage";
import { HelpPage } from "./pages/HelpPage";
import { TeammatePage } from "./pages/TeammatePage";
import { UsagePage } from "./pages/UsagePage";
import { FeatureOffNotice, FeatureRoute, WorkDefFormRoute } from "./components/FeatureGate";
import { MobileShell } from "./mobile/MobileShell";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { MOBILE_ROOT, PHONE_QUERY, isMobilePath, readViewPref, shouldRedirectToMobile } from "./lib/mobile";

function App() {
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  );
}

/** Pick the shell for this path: the phone view under `/m`, the desktop everywhere else. */
function Shell() {
  const { pathname } = useLocation();
  const isPhone = useMediaQuery(PHONE_QUERY);
  if (isMobilePath(pathname)) return <MobileShell />;
  if (shouldRedirectToMobile({ pathname, isPhone, pref: readViewPref(globalThis.localStorage) })) {
    return <Navigate to={MOBILE_ROOT} replace />;
  }
  return <DesktopShell />;
}

/** The desktop shell: the dock and the center. */
function DesktopShell() {
  return (
    <SideDockProvider>
    {/* h-dvh (not min-h-screen) so the shell is exactly the viewport: the side
        columns and <main> then own their own scrolling. With a content-height
        shell, `flex-1 min-h-0` resolves against an auto height, so a long chat
        grows the page instead of scrolling inside the dock. */}
    <div className="h-dvh overflow-hidden flex bg-background text-foreground">
      <SideDock />
      {/* The center column: its own nav on top, the routed page below.
          @container so the nav adapts to the room the docks leave, not the
          viewport width. */}
      <div className="@container flex flex-1 min-w-0 flex-col">
        <NavBar />
        <main className="flex-1 min-h-0 overflow-y-auto">
          <Routes>
            <Route path="/" element={<RootPage />} />
            {/* The chat lives in the dock now; keep the old URL working. */}
            <Route path="/assistant" element={<OpenAssistantTab><Navigate to="/" replace /></OpenAssistantTab>} />
            <Route path="/thoughts" element={<ThoughtsRoute />} />
            {/* A note's triage page: where it becomes work (docs/DESIGN.md "Auto Triage"). */}
            <Route path="/thoughts/:id/triage" element={<TriagePage />} />
            <Route path="/queue" element={<RootPage />} />
            {/* Work Items: Board · Tasks · Schedule · Pending · Archived (lib/work-items.ts). */}
            <Route path="/work-items" element={<WorkItemsIndexRedirect />} />
            <Route path="/work-items/board" element={<FeatureRoute feature="stories"><BoardPage /></FeatureRoute>} />
            <Route path="/work-items/tasks" element={<FeatureRoute feature="tasks"><TasksPage /></FeatureRoute>} />
            <Route path="/work-items/schedule" element={<FeatureRoute feature="schedules"><SchedulePage /></FeatureRoute>} />
            {/* Pending and Archived: one mixed list each; a switched-off kind's rows and chip are hidden. */}
            <Route path="/work-items/pending" element={<LifecyclePage key="pending" state="pending" />} />
            <Route path="/work-items/archived" element={<LifecyclePage key="archived" state="archived" />} />
            {/* The pre-Work-Items URLs (and the hidden Templates) keep working. */}
            <Route path="/board" element={<LegacyWorkItemsRedirect />} />
            <Route path="/tasks" element={<LegacyWorkItemsRedirect />} />
            <Route path="/schedule" element={<LegacyWorkItemsRedirect />} />
            <Route path="/pending" element={<LegacyWorkItemsRedirect />} />
            <Route path="/backlog" element={<LegacyWorkItemsRedirect />} />
            <Route path="/archived" element={<LegacyWorkItemsRedirect />} />
            <Route path="/templates" element={<LegacyWorkItemsRedirect />} />
            <Route path="/templates/:id" element={<LegacyWorkItemsRedirect />} />
            <Route path="/work-defs/new" element={<WorkDefFormRoute><NewWorkDefPage /></WorkDefFormRoute>} />
            <Route path="/work-defs/:id" element={<WorkDefDetailPage />} />
            <Route path="/task/:storyId/:taskId" element={<FeatureRoute feature="stories"><TaskDetailPage /></FeatureRoute>} />
            <Route path="/story/:id" element={<FeatureRoute feature="stories"><StoryDetailPage /></FeatureRoute>} />
            <Route path="/stories/new" element={<FeatureRoute feature="stories"><NewStoryPage /></FeatureRoute>} />
            <Route path="/story/:id/tasks/new" element={<FeatureRoute feature="stories"><NewTaskPage /></FeatureRoute>} />
            <Route path="/config" element={<ConfigPage />} />
            <Route path="/config/:tab" element={<ConfigPage />} />
            {/* A workflow's detail, inside Config's Workflows tab (gated there on Stories). */}
            <Route path="/config/workflows/:name" element={<ConfigPage />} />
            {/* Context and Workflows moved under Config; keep the old URLs working. */}
            <Route path="/context" element={<LegacyConfigRedirect />} />
            <Route path="/workflows" element={<LegacyConfigRedirect />} />
            <Route path="/workflows/:name" element={<LegacyConfigRedirect />} />
            <Route path="/help" element={<HelpPage />} />
            {/* A teammate's live view, opened from the sidebar (docs/DESIGN.md "Watching and Pairing with a Teammate"). */}
            <Route path="/teammates/:id" element={<TeammatePage />} />
            <Route path="/usage" element={<UsagePage />} />
          </Routes>
        </main>
      </div>
    </div>
    </SideDockProvider>
  );
}

/**
 * `/context`, `/workflows`, `/workflows/:name` → their Config tab, keeping any
 * query string. `replace`, so Back doesn't bounce into the redirect.
 */
function LegacyConfigRedirect() {
  const { pathname, search } = useLocation();
  return <Navigate to={(legacyConfigPath(pathname) ?? "/config") + search} replace />;
}

/**
 * `/board`, `/tasks`, `/schedule`, `/pending`, `/backlog`, `/archived`,
 * `/templates[/:id]` → their Work Items sub-tab, keeping any query string.
 * `replace`, so Back doesn't bounce into the redirect.
 */
function LegacyWorkItemsRedirect() {
  const { pathname, search } = useLocation();
  return <Navigate to={(legacyWorkItemsPath(pathname) ?? "/work-items") + search} replace />;
}

/**
 * `/work-items` → its first enabled sub-tab. Nothing until the toggles load;
 * with every kind switched off, the "turned off" notice.
 */
function WorkItemsIndexRedirect() {
  const features = useFeatures();
  if (!features) return null;
  const to = defaultWorkItemsPath(features);
  return to ? <Navigate to={to} replace /> : <FeatureOffNotice />;
}

/**
 * `/thoughts` — a top-level nav page. The canvas owns a full-height layout, so
 * the wrapper is bounded to <main>'s height (h-full) instead of scrolling with
 * the page like the list pages do.
 */
function ThoughtsRoute() {
  return (
    <div className="container mx-auto h-full min-h-0 p-6">
      <ThoughtsPage />
    </div>
  );
}

export default App;
