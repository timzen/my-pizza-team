/**
 * MarkdownView — Renders markdown content using react-markdown.
 * Applies custom styles since @tailwindcss/typography prose classes
 * aren't available in this Tailwind v4 setup.
 */

import Markdown from "react-markdown";
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

export function MarkdownView({ content, className, onToggleTask }: MarkdownViewProps) {
  // Counter reset each render; the `input` component below runs in source order
  // during this same render pass, so each checkbox gets its stable ordinal.
  let taskIndex = -1;
  return (
    <div className={`markdown-view text-sm ${className || ""}`}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="text-xl font-bold mt-4 mb-2">{children}</h1>,
          h2: ({ children }) => <h2 className="text-lg font-bold mt-3 mb-2">{children}</h2>,
          h3: ({ children }) => <h3 className="text-base font-semibold mt-3 mb-1">{children}</h3>,
          h4: ({ children }) => <h4 className="text-sm font-semibold mt-2 mb-1">{children}</h4>,
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
          input: ({ type, checked }) => {
            if (type !== "checkbox") return <input type={type} readOnly />;
            const idx = ++taskIndex;
            return (
              <input
                type="checkbox"
                checked={!!checked}
                disabled={!onToggleTask}
                readOnly={!onToggleTask}
                // Stop the canvas note from starting a drag on checkbox click.
                onPointerDown={(e) => e.stopPropagation()}
                onChange={onToggleTask ? () => onToggleTask(idx) : undefined}
                className={`mr-1 mt-1 align-top ${onToggleTask ? "cursor-pointer" : ""}`}
              />
            );
          },
          code: ({ children, className: codeClassName }) => {
            // Block code has a className like "language-xxx"
            if (codeClassName) {
              return <code className="block bg-muted rounded p-3 text-xs overflow-x-auto mb-2">{children}</code>;
            }
            return <code className="bg-muted rounded px-1.5 py-0.5 text-xs">{children}</code>;
          },
          pre: ({ children }) => <pre className="bg-muted rounded p-3 text-xs overflow-x-auto mb-2">{children}</pre>,
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
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
