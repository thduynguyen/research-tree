import type { ReactNode } from 'react';

const paths: Record<string, ReactNode> = {
  minimize: <path d="M3 12h10" />,
  maximize: <rect x="3" y="3" width="10" height="10" rx="1" />,
  // A box with an arrow leaving it: moves a branch out to its own session, or a session to another project.
  popout: <path d="M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5" strokeLinejoin="round" />,
  back: <path d="M9 3.5L4.5 8 9 12.5M5 8h7" strokeLinejoin="round" />,
  forward: <path d="M7 3.5L11.5 8 7 12.5M11 8H4" strokeLinejoin="round" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2L13.5 13.5" />
    </>
  ),
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  lock: (
    <>
      <rect x="4" y="7.5" width="8" height="6" rx="1" />
      <path d="M5.5 7.5V5.5a2.5 2.5 0 015 0v2" fill="none" />
    </>
  ),
  pin: <path d="M6 2h4l-.5 4.5L12 9H4l2.5-2.5L6 2zM8 9v5" strokeLinejoin="round" />,
};

interface Props {
  icon: keyof typeof paths;
  /** Read by screen readers and shown as the tooltip. */
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}

export function IconButton({ icon, label, pressed, disabled, danger, onClick }: Props) {
  return (
    <button
      type="button"
      className={danger ? 'icon-btn danger' : 'icon-btn'}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill={pressed ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        {paths[icon]}
      </svg>
    </button>
  );
}
