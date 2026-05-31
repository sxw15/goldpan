interface StateLoadingProps {
  label?: string;
}

export function StateLoading({ label }: StateLoadingProps) {
  return (
    <div className="gp-state gp-state--loading" role="status" aria-live="polite">
      <p className="gp-state__title">{label ?? '加载中...'}</p>
    </div>
  );
}
