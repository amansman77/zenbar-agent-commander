// Small hand-rolled markdown renderer for agent output (headings, lists, code
// blocks, inline emphasis/code/links).

import { type ReactNode } from "react";

function renderInlineMarkdown(text: string): ReactNode[] {
  const tokens = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return tokens.map((token, index) => {
    if (token.startsWith("**") && token.endsWith("**")) {
      return <strong key={`bold-${index}`}>{token.slice(2, -2)}</strong>;
    }
    if (token.startsWith("`") && token.endsWith("`")) {
      return (
        <code key={`code-${index}`} className="inline-code">
          {token.slice(1, -1)}
        </code>
      );
    }
    return <span key={`text-${index}`}>{token}</span>;
  });
}

export function MarkdownRenderer({ markdown }: { markdown: string }) {
  const lines = markdown.split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  let key = 0;
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let listBuffer: string[] = [];
  let orderedList = false;

  const flushList = () => {
    if (listBuffer.length === 0) {
      return;
    }
    const items = listBuffer.map((item, itemIndex) => <li key={`item-${itemIndex}`}>{renderInlineMarkdown(item)}</li>);
    blocks.push(orderedList ? <ol key={`ol-${key++}`}>{items}</ol> : <ul key={`ul-${key++}`}>{items}</ul>);
    listBuffer = [];
  };

  const flushCode = () => {
    if (!inCodeBlock) {
      return;
    }
    blocks.push(
      <pre key={`pre-${key++}`} className="output-pre">
        <code>{codeLines.join("\n")}</code>
      </pre>
    );
    codeLines = [];
    inCodeBlock = false;
  };

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      if (inCodeBlock) {
        flushCode();
      } else {
        flushList();
        inCodeBlock = true;
      }
      index += 1;
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      index += 1;
      continue;
    }

    const listMatch = line.match(/^\s*([-*]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      const isOrdered = /\d+\./.test(listMatch[1]);
      if (listBuffer.length > 0 && orderedList !== isOrdered) {
        flushList();
      }
      orderedList = isOrdered;
      listBuffer.push(listMatch[2]);
      index += 1;
      continue;
    }

    flushList();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      const headingText = headingMatch[2];
      if (headingMatch[1].length === 1) {
        blocks.push(<h3 key={`h1-${key++}`}>{renderInlineMarkdown(headingText)}</h3>);
      } else if (headingMatch[1].length === 2) {
        blocks.push(<h4 key={`h2-${key++}`}>{renderInlineMarkdown(headingText)}</h4>);
      } else {
        blocks.push(<h5 key={`h3-${key++}`}>{renderInlineMarkdown(headingText)}</h5>);
      }
      index += 1;
      continue;
    }

    blocks.push(
      <p key={`p-${key++}`} className="markdown-paragraph">
        {renderInlineMarkdown(line)}
      </p>
    );
    index += 1;
  }

  flushList();
  flushCode();
  return <div className="markdown-view">{blocks}</div>;
}
