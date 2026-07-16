/**
 * App.tsx — Root application component with routing and layout.
 */

import { BrowserRouter, Routes, Route } from "react-router-dom";
import { NavBar } from "./components/NavBar";
import { TeammateSidebar } from "./components/TeammateSidebar";
import { RootPage } from "./pages/RootPage";
import { BoardPage } from "./pages/BoardPage";
import { ScratchpadPage } from "./pages/ScratchpadPage";
import { TaskDetailPage } from "./pages/TaskDetailPage";
import { StoryDetailPage } from "./pages/StoryDetailPage";
import { AssistantPage } from "./pages/AssistantPage";
import { BacklogPage } from "./pages/BacklogPage";
import { ArchivedPage } from "./pages/ArchivedPage";
import { ConfigPage } from "./pages/ConfigPage";
import { WorkflowDetailPage } from "./pages/WorkflowDetailPage";
import { HelpPage } from "./pages/HelpPage";

function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen flex flex-col bg-background text-foreground">
        <NavBar />
        <div className="flex flex-1 min-h-0">
          <main className="flex-1 min-w-0 overflow-y-auto">
            <Routes>
              <Route path="/" element={<RootPage />} />
              <Route path="/context" element={<RootPage />} />
              <Route path="/board" element={<BoardPage />} />
              <Route path="/scratchpad" element={<ScratchpadPage />} />
              <Route path="/task/:storyId/:taskId" element={<TaskDetailPage />} />
              <Route path="/story/:id" element={<StoryDetailPage />} />
              <Route path="/assistant" element={<AssistantPage />} />
              <Route path="/backlog" element={<BacklogPage />} />
              <Route path="/archived" element={<ArchivedPage />} />
              <Route path="/config" element={<ConfigPage />} />
              <Route path="/workflows/:name" element={<WorkflowDetailPage />} />
              <Route path="/help" element={<HelpPage />} />
            </Routes>
          </main>
          <TeammateSidebar />
        </div>
      </div>
    </BrowserRouter>
  );
}

export default App;
