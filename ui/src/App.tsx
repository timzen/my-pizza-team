/**
 * App.tsx — Root application component with routing and layout.
 */

import { BrowserRouter, Routes, Route } from "react-router-dom";
import { NavBar } from "./components/NavBar";
import { HomePage } from "./pages/HomePage";
import { BoardPage } from "./pages/BoardPage";
import { TeamPage } from "./pages/TeamPage";
import { MemoryPage } from "./pages/MemoryPage";
import { TaskDetailPage } from "./pages/TaskDetailPage";
import { AssistantPage } from "./pages/AssistantPage";
import { BacklogPage } from "./pages/BacklogPage";
import { ArchivedPage } from "./pages/ArchivedPage";
import { ConfigPage } from "./pages/ConfigPage";

function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-background text-foreground">
        <NavBar />
        <main>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/board" element={<BoardPage />} />
            <Route path="/team" element={<TeamPage />} />
            <Route path="/memory" element={<MemoryPage />} />
            <Route path="/task/:storyId/:taskId" element={<TaskDetailPage />} />
            <Route path="/assistant" element={<AssistantPage />} />
            <Route path="/backlog" element={<BacklogPage />} />
            <Route path="/archived" element={<ArchivedPage />} />
            <Route path="/config" element={<ConfigPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

export default App;
