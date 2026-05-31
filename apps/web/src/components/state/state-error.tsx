interface StateErrorProps {
  error: string | Error;
  onRetry?: () => void;
  retryLabel?: string;
}

export function StateError({ error, onRetry, retryLabel }: StateErrorProps) {
  const message = typeof error === 'string' ? error : error.message;
  return (
    <div className="gp-state gp-state--error" role="alert">
      <p className="gp-state__title">{message}</p>
      {onRetry && (
        <button type="button" className="gp-state__retry" onClick={onRetry}>
          {retryLabel ?? '重试'}
        </button>
      )}
    </div>
  );
}
