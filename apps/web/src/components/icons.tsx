import type { SVGProps } from 'react';

function Icon({ children, ...properties }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...properties}
    >
      {children}
    </svg>
  );
}

export const CalendarIcon = (properties: SVGProps<SVGSVGElement>) => (
  <Icon {...properties}>
    <path d="M7 2v3M17 2v3M3 9h18" />
    <rect x="3" y="4" width="18" height="17" rx="3" />
    <path d="m8 14 2 2 5-5" />
  </Icon>
);

export const FilesIcon = (properties: SVGProps<SVGSVGElement>) => (
  <Icon {...properties}>
    <path d="M14 2H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6M8 13h8M8 16h5" />
  </Icon>
);

export const UserIcon = (properties: SVGProps<SVGSVGElement>) => (
  <Icon {...properties}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21a8 8 0 0 1 16 0" />
  </Icon>
);

export const SearchIcon = (properties: SVGProps<SVGSVGElement>) => (
  <Icon {...properties}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-4-4" />
  </Icon>
);

export const UploadIcon = (properties: SVGProps<SVGSVGElement>) => (
  <Icon {...properties}>
    <path d="M12 16V4M7 9l5-5 5 5" />
    <path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
  </Icon>
);

export const ArrowIcon = (properties: SVGProps<SVGSVGElement>) => (
  <Icon {...properties}>
    <path d="m9 18 6-6-6-6" />
  </Icon>
);

export const CloseIcon = (properties: SVGProps<SVGSVGElement>) => (
  <Icon {...properties}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);

export const CheckIcon = (properties: SVGProps<SVGSVGElement>) => (
  <Icon {...properties}>
    <path d="m5 12 4 4L19 6" />
  </Icon>
);

export const LinkIcon = (properties: SVGProps<SVGSVGElement>) => (
  <Icon {...properties}>
    <path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1.1" />
    <path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1.1" />
  </Icon>
);
