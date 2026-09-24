/**
 * App.tsx — Root application component with routing and layout.
 *
 * The shell reads left-to-right as the life of a piece of work: the
 * **AssistantDock** on the left is where work starts (chat + quick-create),
 * routed pages run in the middle, and the **TeammateSidebar** on the right is
 * where it executes (team + queue). Both edges collapse to icon rails.
 *
 * Three full-height columns with aligned h-14 headers. The **NavBar spans only
 * the center column**: it navigates the center, and the side columns are
 * independent of it (docs/TEAMMATE_CHAT.md §2).
 */

import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { NavBar } from "./components/NavBar";
import { TeammateSidebar } from "./components/TeammateSidebar";
import { AssistantDock } from "./components/assistant/AssistantDock";
import { AssistantDockProvider, OpenAssistantDock } from "./components/assistant/AssistantDockProvider";
import { RootPage } from "./pages/RootPage";
import { BoardPage } from "./pages/BoardPage";
import { TaskDetailPage } from "./pages/TaskDetailPage";
import { StoryDetailPage } from "./pages/StoryDetailPage";
import { ContextPage } from "./pages/ContextPage";
import { WorkflowsPage } from "./pages/WorkflowsPage";
import { TasksPage } from "./pages/TasksPage";
import { TemplatesPage } from "./pages/TemplatesPage";
import { TemplateDetailPage } from "./pages/TemplateDetailPage";
import { SchedulePage } from "./pages/SchedulePage";
import { NewWorkDefPage } from "./pages/NewWorkDefPage";
import { WorkDefDetailPage } from "./pages/WorkDefDetailPage";
import { BacklogPage } from "./pages/BacklogPage";
import { ArchivedPage } from "./pages/ArchivedPage";
import { NewStoryPage } from "./pages/NewStoryPage";
import { NewTaskPage } from "./pages/NewTaskPage";
import { ConfigPage } from "./pages/ConfigPage";
import { WorkflowDetailPage } from "./pages/WorkflowDetailPage";
import { HelpPage } from "./pages/HelpPage";

function App() {
  return (
    <BrowserRouter>
      <AssistantDockProvider>
      {/* h-dvh (not min-h-screen) so the shell is exactly the viewport: the side
          columns and <main> then own their own scrolling. With a content-height
          shell, `flex-1 min-h-0` resolves against an auto height, so a long chat
          grows the page instead of scrolling inside the dock. */}
      <div className="h-dvh overflow-hidden flex bg-background text-foreground">
        <AssistantDock />
        {/* The center column: its own nav on top, the routed page below.
            @container so the nav adapts to the room the docks leave, not the
            viewport width. */}
        <div className="@container flex flex-1 min-w-0 flex-col">
          <NavBar />
          <main className="flex-1 min-h-0 overflow-y-auto">
            <Routes>
              <Route path="/" element={<RootPage />} />
              {/* The chat lives in the dock now; keep the old URL working. */}
              <Route path="/assistant" element={<OpenAssistantDock><Navigate to="/" replace /></OpenAssistantDock>} />
              <Route path="/thoughts" element={<RootPage />} />
              <Route path="/context" element={<ContextPage />} />
              <Route path="/board" element={<BoardPage />} />
              <Route path="/tasks" element={<TasksPage />} />
              <Route path="/templates" element={<TemplatesPage />} />
              <Route path="/templates/:id" element={<TemplateDetailPage />} />
              <Route path="/schedule" element={<SchedulePage />} />
              <Route path="/work-defs/new" element={<NewWorkDefPage />} />
              <Route path="/work-defs/:id" element={<WorkDefDetailPage />} />
              <Route path="/task/:storyId/:taskId" element={<TaskDetailPage />} />
              <Route path="/story/:id" element={<StoryDetailPage />} />
              <Route path="/stories/new" element={<NewStoryPage />} />
              <Route path="/story/:id/tasks/new" element={<NewTaskPage />} />
              <Route path="/backlog" element={<BacklogPage />} />
              <Route path="/archived" element={<ArchivedPage />} />
              <Route path="/config" element={<ConfigPage />} />
              <Route path="/config/:tab" element={<ConfigPage />} />
              <Route path="/workflows" element={<WorkflowsPage />} />
              <Route path="/workflows/:name" element={<WorkflowDetailPage />} />
              <Route path="/help" element={<HelpPage />} />
            </Routes>
          </main>
        </div>
        <TeammateSidebar />
      </div>
      </AssistantDockProvider>
    </BrowserRouter>
  );
}

export default App;
