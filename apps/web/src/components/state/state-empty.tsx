interface StateEmptyProps {
  title: string;
  description?: string;
  action?: React.ReactNode;
}

export function StateEmpty({ title, description, action }: StateEmptyProps) {
  return (
    <div className="gp-state gp-state--empty">
      <p className="gp-state__title">{title}</p>
      {description && <p className="gp-state__description">{description}</p>}
      {action && <div className="gp-state__action">{action}</div>}
    </div>
  );
}
