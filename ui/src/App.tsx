/**
 * App.tsx — Root application component with routing and layout.
 *
 * The shell reads left-to-right as the life of a piece of work: the
 * **AssistantDock** on the left is where work starts (chat + quick-create),
 * routed pages run in the middle, and the **TeammateSidebar** on the right is
 * where it executes (team + queue). Both edges collapse to icon rails.
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
import { SpawnPage } from "./pages/SpawnPage";
import { ConfigPage } from "./pages/ConfigPage";
import { WorkflowDetailPage } from "./pages/WorkflowDetailPage";
import { HelpPage } from "./pages/HelpPage";

function App() {
  return (
    <BrowserRouter>
      <AssistantDockProvider>
      <div className="min-h-screen flex flex-col bg-background text-foreground">
        <NavBar />
        <div className="flex flex-1 min-h-0">
          <AssistantDock />
          <main className="flex-1 min-w-0 overflow-y-auto">
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
              <Route path="/spawn" element={<SpawnPage />} />
              <Route path="/backlog" element={<BacklogPage />} />
              <Route path="/archived" element={<ArchivedPage />} />
              <Route path="/config" element={<ConfigPage />} />
              <Route path="/config/:tab" element={<ConfigPage />} />
              <Route path="/workflows" element={<WorkflowsPage />} />
              <Route path="/workflows/:name" element={<WorkflowDetailPage />} />
              <Route path="/help" element={<HelpPage />} />
            </Routes>
          </main>
          <TeammateSidebar />
        </div>
      </div>
      </AssistantDockProvider>
    </BrowserRouter>
  );
}

export default App;
