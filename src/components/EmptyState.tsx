import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  body: string;
  /** Optional action, for example a button. */
  children?: ReactNode;
}

export function EmptyState({ icon, title, body, children }: EmptyStateProps) {
  return (
    <div className="card empty-state">
      <div className="empty-state-icon" aria-hidden="true">
        {icon}
      </div>
      <h2 className="empty-state-title">{title}</h2>
      <p className="empty-state-body">{body}</p>
      {children}
    </div>
  );
}
