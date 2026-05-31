'use client';

interface ContentResultProps {
  result: {
    text: string;
    format?: 'text' | 'markdown';
    title?: string;
  };
}

export function ContentResultCard({ result }: ContentResultProps) {
  // TODO: When implementing format='markdown' rendering, use a sanitized renderer
  // (e.g. react-markdown + rehype-sanitize) to prevent XSS from external plugins.
  return (
    <div className="gp-content-result">
      {result.title && <div className="gp-content-result__title">{result.title}</div>}
      <div className="gp-content-result__text">{result.text}</div>
    </div>
  );
}
