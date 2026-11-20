import type { PointerEvent as ReactPointerEvent } from 'react';

interface Props {
  label: string;
  /** 'x' sets the width of the panel to the left, 'y' the height of the one above. */
  axis?: 'x' | 'y';
  min?: number;
  max?: number;
  onChange: (size: number) => void;
}

/** A draggable divider that resizes the element just before it. */
export function Handle({ label, axis = 'x', min = 160, max = 1600, onChange }: Props) {
  const clamp = (v: number) => Math.round(Math.max(min, Math.min(max, v)));
  const sizeOf = (handle: Element) => {
    const rect = handle.previousElementSibling!.getBoundingClientRect();
    return axis === 'x' ? rect.width : rect.height;
  };

  const start = (e: ReactPointerEvent) => {
    e.preventDefault();
    const from = axis === 'x' ? e.clientX : e.clientY;
    const size = sizeOf(e.currentTarget);
    const move = (ev: PointerEvent) => onChange(clamp(size + (axis === 'x' ? ev.clientX : ev.clientY) - from));
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      document.body.classList.remove('resizing-x', 'resizing-y');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    document.body.classList.add(`resizing-${axis}`);
  };

  const [less, more] = axis === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
  return (
    <div
      className={`handle ${axis}`}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      tabIndex={0}
      onPointerDown={start}
      onKeyDown={(e) => {
        if (e.key === less) onChange(clamp(sizeOf(e.currentTarget) - 24));
        if (e.key === more) onChange(clamp(sizeOf(e.currentTarget) + 24));
      }}
    />
  );
}
