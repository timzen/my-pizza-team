/**
 * thoughtColors — the fixed 6-key note palette for the Thoughts canvas.
 * Static Tailwind class maps (so the v4 scanner picks them up — never build
 * class names dynamically). Light/dark aware.
 */

export const THOUGHT_COLORS = ["yellow", "blue", "green", "pink", "purple", "orange"] as const;
export type ThoughtColor = (typeof THOUGHT_COLORS)[number];

/** Note body: background + border. */
export const NOTE_CLASSES: Record<string, string> = {
  yellow: "bg-yellow-100 border-yellow-300 dark:bg-yellow-900/40 dark:border-yellow-700/60",
  blue: "bg-blue-100 border-blue-300 dark:bg-blue-900/40 dark:border-blue-700/60",
  green: "bg-green-100 border-green-300 dark:bg-green-900/40 dark:border-green-700/60",
  pink: "bg-pink-100 border-pink-300 dark:bg-pink-900/40 dark:border-pink-700/60",
  purple: "bg-purple-100 border-purple-300 dark:bg-purple-900/40 dark:border-purple-700/60",
  orange: "bg-orange-100 border-orange-300 dark:bg-orange-900/40 dark:border-orange-700/60",
};

/** Small solid swatch (palette picker + group tint). */
export const DOT_CLASSES: Record<string, string> = {
  yellow: "bg-yellow-400",
  blue: "bg-blue-400",
  green: "bg-green-400",
  pink: "bg-pink-400",
  purple: "bg-purple-400",
  orange: "bg-orange-400",
};

export function noteClass(color: string): string {
  return NOTE_CLASSES[color] ?? NOTE_CLASSES.yellow;
}
export function dotClass(color: string): string {
  return DOT_CLASSES[color] ?? DOT_CLASSES.yellow;
}
