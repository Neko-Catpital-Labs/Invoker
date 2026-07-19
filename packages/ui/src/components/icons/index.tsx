import type { JSX, SVGProps } from 'react';

export function SendArrowIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg
      aria-hidden={props['aria-hidden'] ?? 'true'}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.75"
      {...props}
    >
      <path d="M8 13V3" />
      <path d="M4 7l4-4 4 4" />
    </svg>
  );
}
