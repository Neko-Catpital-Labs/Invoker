import Markdown from 'react-markdown';

export function MarkdownText({ text, className = '' }: { text: string; className?: string }): JSX.Element {
  return (
    <div className={className}>
      <Markdown
        components={{
          p: ({ children }) => <p className="whitespace-pre-wrap [&:not(:first-child)]:mt-2">{children}</p>,
          ul: ({ children }) => <ul className="my-1 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-1 list-decimal space-y-1 pl-5">{children}</ol>,
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.92em] text-foreground">{children}</code>,
          strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
