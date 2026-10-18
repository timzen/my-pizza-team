/**
 * PendingPage — The Board's Pending tab (/pending): stories held in the
 * reversible pending state (docs/DESIGN.md "Pending: Write, Review, Activate").
 *
 * It is the board itself filtered to pending stories (BoardPage `view="pending"`),
 * not a separate list: a story made pending mid-flight can still have a task
 * finishing in an agent state, so its lanes stay visible. Each story's ▶
 * activates it (back to the Board tab). Replaced the old Backlog tab.
 */

import { BoardPage } from "./BoardPage";

export function PendingPage() {
  return <BoardPage view="pending" />;
}
