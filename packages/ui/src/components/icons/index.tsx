import type { JSX, SVGProps } from 'react';

export function SendIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg
      aria-hidden={props['aria-hidden'] ?? 'true'}
      viewBox="0 0 20 20"
      fill="currentColor"
      {...props}
    >
      <path d="M2.23 3.27a.75.75 0 0 1 .8-.12l14 6a.75.75 0 0 1 0 1.38l-14 6A.75.75 0 0 1 2 15.84V11l7.24-1L2 9V4.16a.75.75 0 0 1 .23-.89Z" />
    </svg>
  );
}
