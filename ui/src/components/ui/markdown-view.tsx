/**
 * MarkdownView — Renders markdown content using react-markdown.
 * Applies custom styles since @tailwindcss/typography prose classes
 * aren't available in this Tailwind v4 setup.
 *
 * The `components` map and plugin lists are module-level constants on purpose:
 * react-markdown uses each entry as a React component *type*, so a map built
 * inside render gives every element a new type on every render, and React
 * unmounts and remounts the whole rendered document — which wipes the user's
 * text selection each time a poll or a stream frame re-renders the parent
 * (docs/DESIGN.md "Polling Never Disturbs the Reader"). The only per-render
 * input, the task-list toggle, reaches the checkboxes through a context, and
 * each checkbox's ordinal is stamped onto the tree by a rehype plugin rather
 * than counted during render. The same plugin stamps each checkbox's item
 * text, which becomes its accessible name (a bare checkbox says nothing).
 *
 * Headings render one level down (a document's `#` is an h2), because the
 * markdown always sits under its page's own h1; and a code block that scrolls
 * sideways is a keyboard tab stop (ScrollablePre) — docs/ACCESSIBILITY.md.
 */

import { createContext, useContext, useLayoutEffect, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownViewProps {
  content: string;
  className?: string;
  /**
   * When provided, GFM task-list checkboxes become interactive: clicking the
   * Nth checkbox calls onToggleTask(N) (0-based, source order). Omit for a
   * read-only render (checkboxes shown disabled).
   */
  onToggleTask?: (index: number) => void;
}

/** The enclosing MarkdownView's task toggle, if its checkboxes are interactive. */
const ToggleTaskContext = createContext<((index: number) => void) | undefined>(undefined);

/** A minimal hast node: just what `numberTaskCheckboxes` walks. */
interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
}

/** A task item's own checkbox: directly in the `li`, or in its first paragraph (a loose list). */
function taskCheckbox(li: HastNode): HastNode | undefined {
  const isBox = (c: HastNode) => c.type === "element" && c.tagName === "input" && c.properties?.type === "checkbox";
  const first = li.children?.find((c) => c.type === "element");
  return li.children?.find(isBox) ?? (first?.tagName === "p" ? first.children?.find(isBox) : undefined);
}

/** The text under a hast node (a task item's words, for its checkbox's name). */
function hastText(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

/**
 * Rehype plugin: give each task-list checkbox its 0-based source-order ordinal
 * (`dataTaskIndex`), so the checkbox component needs no render-time counter
 * (which also double-counted under StrictMode's double render).
 */
function numberTaskCheckboxes() {
  return (tree: HastNode) => {
    let n = 0;
    const walk = (node: HastNode) => {
      if (node.type === "element" && node.tagName === "input" && node.properties?.type === "checkbox") {
        node.properties.dataTaskIndex = n++;
      }
      // A task item: name its checkbox by the item's own text.
      if (node.type === "element" && node.tagName === "li") {
        const box = taskCheckbox(node);
        if (box?.properties) box.properties.dataTaskLabel = hastText(node).trim().split("\n")[0];
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [numberTaskCheckboxes];

/** A task-list checkbox: interactive when the MarkdownView has `onToggleTask`. */
function TaskInput({ type, checked, node }: React.ComponentProps<"input"> & { node?: HastNode }) {
  const onToggleTask = useContext(ToggleTaskContext);
  if (type !== "checkbox") return <input type={type} readOnly />;
  const idx = Number(node?.properties?.dataTaskIndex ?? -1);
  const label = String(node?.properties?.dataTaskLabel ?? "") || `Task ${idx + 1}`;
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={!!checked}
      disabled={!onToggleTask}
      readOnly={!onToggleTask}
      // Stop the canvas note from starting a drag on checkbox click.
      onPointerDown={(e) => e.stopPropagation()}
      onChange={onToggleTask ? () => onToggleTask(idx) : undefined}
      className={`mr-1 mt-1 align-top ${onToggleTask ? "cursor-pointer" : ""}`}
    />
  );
}

/**
 * A code block. It scrolls sideways when a line is too long, and a scrolling
 * region must be reachable by keyboard (WCAG 2.1.1; axe
 * `scrollable-region-focusable`) — so it becomes a named tab stop then, and
 * only then: a short block that doesn't scroll adds no tab stop.
 */
function ScrollablePre({ children }: React.ComponentProps<"pre">) {
  const ref = useRef<HTMLPreElement>(null);
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setScrolls(el.scrollWidth > el.clientWidth);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <pre
      ref={ref}
      className="bg-muted rounded p-3 text-xs overflow-x-auto mb-2"
      tabIndex={scrolls ? 0 : undefined}
      role={scrolls ? "group" : undefined}
      aria-label={scrolls ? "Code block" : undefined}
    >
      {children}
    </pre>
  );
}

const COMPONENTS: Components = {
  // One level down: rendered markdown always sits under its page's own h1
  // (docs/ACCESSIBILITY.md "Structure"), so a document's `#` is an h2. The
  // look follows the markdown level, not the tag.
  h1: ({ children }) => <h2 className="text-xl font-bold mt-4 mb-2">{children}</h2>,
  h2: ({ children }) => <h3 className="text-lg font-bold mt-3 mb-2">{children}</h3>,
  h3: ({ children }) => <h4 className="text-base font-semibold mt-3 mb-1">{children}</h4>,
  h4: ({ children }) => <h5 className="text-sm font-semibold mt-2 mb-1">{children}</h5>,
  h5: ({ children }) => <h6 className="text-sm font-semibold mt-2 mb-1">{children}</h6>,
  h6: ({ children }) => <h6 className="text-sm font-semibold mt-2 mb-1">{children}</h6>,
  p: ({ children }) => <p className="mb-2 leading-relaxed">{children}</p>,
  // Task lists (contains-task-list) drop the bullet so the checkbox is
  // the only marker; ordinary lists keep their disc/decimal.
  ul: ({ children, className: c }) =>
    c?.includes("contains-task-list")
      ? <ul className="list-none pl-1 mb-2 space-y-1">{children}</ul>
      : <ul className="list-disc pl-5 mb-2 space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 space-y-1">{children}</ol>,
  li: ({ children, className: c }) =>
    c?.includes("task-list-item")
      ? <li className="list-none flex items-start gap-1 leading-relaxed">{children}</li>
      : <li className="leading-relaxed">{children}</li>,
  input: TaskInput,
  code: ({ children, className: codeClassName }) => {
    // Block code has a className like "language-xxx"
    if (codeClassName) {
      // The enclosing <pre> pads, tints and scrolls it (ScrollablePre).
      return <code className="block">{children}</code>;
    }
    return <code className="bg-muted rounded px-1.5 py-0.5 text-xs">{children}</code>;
  },
  pre: ScrollablePre,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener" className="text-primary underline hover:text-primary/80">
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-muted-foreground/30 pl-3 italic text-muted-foreground mb-2">
      {children}
    </blockquote>
  ),
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  hr: () => <hr className="border-border my-3" />,
};

export function MarkdownView({ content, className, onToggleTask }: MarkdownViewProps) {
  return (
    <div className={`markdown-view text-sm ${className || ""}`}>
      <ToggleTaskContext.Provider value={onToggleTask}>
        <Markdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={COMPONENTS}>
          {content}
        </Markdown>
      </ToggleTaskContext.Provider>
    </div>
  );
}
