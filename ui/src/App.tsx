/**
 * App.tsx — Root application component with routing and layout.
 */

import { BrowserRouter, Routes, Route } from "react-router-dom";
import { NavBar } from "./components/NavBar";
import { HomePage } from "./pages/HomePage";
import { BoardPage } from "./pages/BoardPage";
import { TeammatesPage } from "./pages/TeammatesPage";
import { ContextPage } from "./pages/ContextPage";
import { ScratchpadPage } from "./pages/ScratchpadPage";
import { TaskDetailPage } from "./pages/TaskDetailPage";
import { StoryDetailPage } from "./pages/StoryDetailPage";
import { AssistantPage } from "./pages/AssistantPage";
import { BacklogPage } from "./pages/BacklogPage";
import { ArchivedPage } from "./pages/ArchivedPage";
import { ConfigPage } from "./pages/ConfigPage";
import { WorkflowsPage } from "./pages/WorkflowsPage";
import { WorkflowDetailPage } from "./pages/WorkflowDetailPage";
import { HelpPage } from "./pages/HelpPage";

function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-background text-foreground">
        <NavBar />
        <main>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/board" element={<BoardPage />} />
            <Route path="/team" element={<TeammatesPage />} />
            <Route path="/context" element={<ContextPage />} />
            <Route path="/scratchpad" element={<ScratchpadPage />} />
            <Route path="/task/:storyId/:taskId" element={<TaskDetailPage />} />
            <Route path="/story/:id" element={<StoryDetailPage />} />
            <Route path="/assistant" element={<AssistantPage />} />
            <Route path="/backlog" element={<BacklogPage />} />
            <Route path="/archived" element={<ArchivedPage />} />
            <Route path="/config" element={<ConfigPage />} />
            <Route path="/workflows" element={<WorkflowsPage />} />
            <Route path="/workflows/:name" element={<WorkflowDetailPage />} />
            <Route path="/help" element={<HelpPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

export default App;
