import type { ButtonHTMLAttributes, HTMLAttributes, PropsWithChildren } from 'react';

export function Button({
  className = '',
  children,
  ...properties
}: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>) {
  return (
    <button className={`ui-button ${className}`.trim()} {...properties}>
      {children}
    </button>
  );
}

export function Card({
  className = '',
  children,
  ...properties
}: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return (
    <div className={`ui-card ${className}`.trim()} {...properties}>
      {children}
    </div>
  );
}

export function Spinner({ label = 'Загрузка' }: { label?: string }) {
  return (
    <span className="ui-spinner" role="status" aria-label={label}>
      <span aria-hidden="true" />
    </span>
  );
}
