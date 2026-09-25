/**
 * lib/taskMarkers — GFM checklist editing for Thoughts notes: flip the Nth
 * `- [ ]` ↔ `- [x]` marker (source order), so a checkbox click on a rendered
 * note rewrites its markdown. Shared by the canvas and the note dialog.
 */

export function toggleTaskMarker(content: string, index: number): string {
  let i = -1;
  return content.replace(/(^[ \t]*[-*+] \[)([ xX])(\])/gm, (m, pre, mark, post) => {
    i++;
    return i === index ? `${pre}${mark === " " ? "x" : " "}${post}` : m;
  });
}
