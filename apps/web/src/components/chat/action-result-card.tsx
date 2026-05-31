'use client';

interface ActionResultProps {
  result: {
    message: string;
    actionId?: string;
  };
}

export function ActionResultCard({ result }: ActionResultProps) {
  return (
    <div className="gp-action-result">
      <div className="gp-action-result__message">{result.message}</div>
    </div>
  );
}
