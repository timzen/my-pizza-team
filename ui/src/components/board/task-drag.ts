/**
 * task-drag.ts — Drag payload MIME type for board task cards. The story id is
 * baked in so a swimlane can accept only its own tasks during dragover
 * (dataTransfer values are unreadable until drop, but the *types* are
 * visible). Lives in its own file so component files export only components
 * (react-refresh).
 */

export function taskDragType(storyId: string): string {
  return `application/x-mpt-task--${storyId.toLowerCase()}`;
}
