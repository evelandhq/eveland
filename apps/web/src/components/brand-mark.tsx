import type { SVGProps } from "react";

export function BrandMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 44 48" fill="none" aria-hidden="true" {...props}>
      <g fill="currentColor">
        <path d="M17 10l4.8 11.2L33 26l-11.2 4.8L17 42l-4.8-11.2L1 26l11.2-4.8z" />
        <path d="M35 5l2.4 5.6L43 13l-5.6 2.4L35 21l-2.4-5.6L27 13l5.6-2.4z" opacity=".45" />
      </g>
    </svg>
  );
}
