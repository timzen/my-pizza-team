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
 * Sources, Workflows and Personas are tabs of the Config page
 * (`/config/sources[/:sourceId]`, `/config/workflows[/:name]`,
 * `/config/personas[/:id]`).
 *
 * Board, Tasks, and Schedule are sub-tabs of **Work** (`/work/board
 * |tasks|schedule|pending|archived`, lib/work-items.ts); `/work` lands on
 * the first enabled tab. Each registered external Work Source adds a read-only
 * tab at `/work/source/:sourceId` (pages/ExternalSourcePage). Templates are
 * hidden from the UI (being deprecated — the daemon's template API and data are
 * untouched). The pre-Work and pre-Config URLs (`/board`, `/tasks`, `/workflows`,
 * `/context`, …) no longer redirect; their shims were removed.
 */

import { useRef } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { defaultWorkItemsPath } from "./lib/work-items";
import { useExternalSources, useFeatures } from "./hooks/useFeatures";
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
import { ExternalSourcePage } from "./pages/ExternalSourcePage";
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
import { SkipLink } from "./components/SkipLink";
import { TourProvider } from "./components/tour/TourProvider";
import { useDocumentTitle } from "./hooks/useDocumentTitle";
import { useRouteFocus } from "./hooks/useRouteFocus";
import { pageTitleForPath } from "./lib/page-title";
import { MAIN_CONTENT_ID } from "./lib/route-focus";

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

/**
 * The desktop shell: the dock and the center. Its page structure
 * (docs/ACCESSIBILITY.md "Structure"): a skip link first, the dock and the
 * NavBar as labelled `<nav>`s, one `<main>` holding the routed page, the tab's
 * title from the path (detail pages set their own), and focus moved to the new
 * page's heading on navigation (hooks/useRouteFocus). The optional guided tour
 * (components/tour/TourProvider) is drawn over it; the phone shell has none.
 */
function DesktopShell() {
  const mainRef = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  useDocumentTitle(pageTitleForPath(pathname));
  useRouteFocus(mainRef);
  return (
    <SideDockProvider>
    <TourProvider>
    {/* h-dvh (not min-h-screen) so the shell is exactly the viewport: the side
        columns and <main> then own their own scrolling. With a content-height
        shell, `flex-1 min-h-0` resolves against an auto height, so a long chat
        grows the page instead of scrolling inside the dock. */}
    <div className="h-dvh overflow-hidden flex bg-background text-foreground">
      <SkipLink mainRef={mainRef} />
      <SideDock />
      {/* The center column: its own nav on top, the routed page below.
          @container so the nav adapts to the room the docks leave, not the
          viewport width. */}
      <div className="@container flex flex-1 min-w-0 flex-col">
        <NavBar />
        <main ref={mainRef} id={MAIN_CONTENT_ID} tabIndex={-1} className="flex-1 min-h-0 overflow-y-auto">
          <Routes>
            <Route path="/" element={<RootPage />} />
            {/* The chat lives in the dock now; keep the old URL working. */}
            <Route path="/assistant" element={<OpenAssistantTab><Navigate to="/" replace /></OpenAssistantTab>} />
            <Route path="/thoughts" element={<ThoughtsRoute />} />
            {/* A note's triage page: where it becomes work (docs/DESIGN.md "Auto Triage"). */}
            <Route path="/thoughts/:id/triage" element={<TriagePage />} />
            <Route path="/queue" element={<RootPage />} />
            {/* Work: Board · Tasks · Schedule · Pending · Archived (lib/work-items.ts). */}
            <Route path="/work" element={<WorkItemsIndexRedirect />} />
            <Route path="/work/board" element={<FeatureRoute feature="stories"><BoardPage /></FeatureRoute>} />
            <Route path="/work/tasks" element={<FeatureRoute feature="tasks"><TasksPage /></FeatureRoute>} />
            <Route path="/work/schedule" element={<FeatureRoute feature="schedules"><SchedulePage /></FeatureRoute>} />
            {/* Pending and Archived: one mixed list each; a switched-off kind's rows and chip are hidden. */}
            <Route path="/work/pending" element={<LifecyclePage key="pending" state="pending" />} />
            <Route path="/work/archived" element={<LifecyclePage key="archived" state="archived" />} />
            {/* One generic, read-only tab per external (pull-only) Work Source (docs/DESIGN.md "Work Sources"). */}
            <Route path="/work/source/:sourceId" element={<ExternalSourcePage />} />
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
            {/* A Work Source's settings, inside Config's Sources tab. */}
            <Route path="/config/sources/:sourceId" element={<ConfigPage />} />
            {/* A persona, inside Config's Personas tab. A splat: package ids contain "/". */}
            <Route path="/config/personas/*" element={<ConfigPage />} />
            {/* The guide: Getting Started at /help, a topic at /help/:topic (lib/help.ts helpPath). */}
            <Route path="/help" element={<HelpPage />} />
            <Route path="/help/:topic" element={<HelpPage />} />
            {/* A teammate's live view, opened from the sidebar (docs/DESIGN.md "Watching and Pairing with a Teammate"). */}
            <Route path="/teammates/:id" element={<TeammatePage />} />
            <Route path="/usage" element={<UsagePage />} />
          </Routes>
        </main>
      </div>
    </div>
    </TourProvider>
    </SideDockProvider>
  );
}

/**
 * `/work` → its first enabled sub-tab. Nothing until the toggles load;
 * with every kind switched off, the "turned off" notice.
 */
function WorkItemsIndexRedirect() {
  const features = useFeatures();
  const sources = useExternalSources();
  if (!features) return null;
  const to = defaultWorkItemsPath(features, sources);
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
