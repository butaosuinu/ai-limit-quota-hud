/**
 * Minimal Feather-style stroke icons (16x16, currentColor) used by the
 * Raycast-inspired settings panel. Inline so the bundle stays free of
 * icon-library deps.
 */

import type { SVGProps } from "react";

type IconProps = Omit<SVGProps<SVGSVGElement>, "children">;

function Svg({
  children,
  ...props
}: SVGProps<SVGSVGElement> & { children: React.ReactNode }) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function OpacityIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function LayersIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 2 2 5l6 3 6-3-6-3z" />
      <path d="M2 10.5 8 13.5l6-3" />
      <path d="M2 8 8 11l6-3" opacity="0.55" />
    </Svg>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="7" width="10" height="6.5" rx="1.5" />
      <path d="M5 7V5a3 3 0 1 1 6 0v2" />
    </Svg>
  );
}

export function PointerIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 2.5v9l2.5-2.2 1.7 3.5 1.6-.8-1.7-3.5 3.2-.4z" />
    </Svg>
  );
}

export function EyeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </Svg>
  );
}

export function CrosshairIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2v3M8 11v3M2 8h3M11 8h3" />
      <circle cx="8" cy="8" r="0.5" fill="currentColor" />
    </Svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </Svg>
  );
}

export function LoginIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 3h3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H9" />
      <path d="M2.5 8h7.5" />
      <path d="m7 5.5 2.5 2.5L7 10.5" />
    </Svg>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.5 4h11" />
      <path d="M5 4V2.5h6V4" />
      <path d="M4 4v9a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4" />
      <path d="M6.5 7v4M9.5 7v4" />
    </Svg>
  );
}

export function ResetIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.5 5.5V2.5" />
      <path d="M2.5 5.5h3" />
      <path d="M3.2 8.5a5 5 0 1 0 1-4l-1.7 1.5" />
    </Svg>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 7v3.5" />
      <circle cx="8" cy="5" r="0.5" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function SparkleIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M8 2.5 9 6l3.5 1L9 8l-1 3.5L7 8 3.5 7 7 6z"
        fill="currentColor"
      />
    </Svg>
  );
}

export function ChatIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.5 3.5h11a1 1 0 0 1 1 1V11a1 1 0 0 1-1 1H6.5l-3 2v-2h-1a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z" />
    </Svg>
  );
}

export function GlobeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.5 8h11" />
      <path d="M8 2.5a8 6 0 0 1 0 11a8 6 0 0 1 0-11z" />
    </Svg>
  );
}

export function MenuBarIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="1.5" y="2.5" width="13" height="3" rx="1" />
      <path d="M10 4h2.5" />
      <rect x="3.5" y="9" width="9" height="4.5" rx="1" opacity="0.45" />
    </Svg>
  );
}
