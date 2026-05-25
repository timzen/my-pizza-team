// Permission bypass during autonomous task execution
// When the teammate is autonomously working on a task, we short-circuit
// tool_call events so the permission system doesn't prompt for every action.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkLoop } from "./loop.js";

export function registerPermissionBypass(pi: ExtensionAPI, getLoop: () => WorkLoop): void {
  pi.on("tool_call", async (event, ctx) => {
    const loop = getLoop();

    // If the teammate is autonomously working, allow everything
    if (loop.isAutonomous && loop.currentTask) {
      // Return undefined = don't block, let it through
      return undefined;
    }

    // Otherwise, let other handlers (e.g., permission system) handle it
    return undefined;
  });
}
