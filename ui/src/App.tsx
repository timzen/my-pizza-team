/**
 * App.tsx — Root application component with routing and layout.
 */

import { BrowserRouter, Routes, Route } from "react-router-dom";
import { NavBar } from "./components/NavBar";
import { HomePage } from "./pages/HomePage";
import { BoardPage } from "./pages/BoardPage";
import { TeamPage } from "./pages/TeamPage";
import { MemoryPage } from "./pages/MemoryPage";

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
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

export default App;
