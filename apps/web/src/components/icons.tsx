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

export const ProjectIcon = (properties: SVGProps<SVGSVGElement>) => (
  <Icon {...properties}>
    <path d="M4 20V6a2 2 0 0 1 2-2h5l2 3h5a2 2 0 0 1 2 2v11Z" />
    <path d="M8 12h8M8 16h5" />
  </Icon>
);

export const UserIcon = (properties: SVGProps<SVGSVGElement>) => (
  <Icon {...properties}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21a8 8 0 0 1 16 0" />
  </Icon>
);

export const PhoneIcon = (properties: SVGProps<SVGSVGElement>) => (
  <Icon {...properties}>
    <path d="M7.2 3.6 9.3 7a1.4 1.4 0 0 1-.2 1.7L7.7 10a15.5 15.5 0 0 0 6.3 6.3l1.3-1.4a1.4 1.4 0 0 1 1.7-.2l3.4 2.1a1.4 1.4 0 0 1 .6 1.6l-.5 2A2.1 2.1 0 0 1 18.4 22C9.3 21.4 2.6 14.7 2 5.6a2.1 2.1 0 0 1 1.6-2.1l2-.5a1.4 1.4 0 0 1 1.6.6Z" />
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

export const HomeIcon = (properties: SVGProps<SVGSVGElement>) => (
  <Icon {...properties}>
    <path d="m3 11 9-8 9 8" />
    <path d="M5 10v10h14V10M9 20v-6h6v6" />
  </Icon>
);

export const QrIcon = (properties: SVGProps<SVGSVGElement>) => (
  <Icon {...properties}>
    <rect x="3" y="3" width="6" height="6" rx="1" />
    <rect x="15" y="3" width="6" height="6" rx="1" />
    <rect x="3" y="15" width="6" height="6" rx="1" />
    <path d="M15 15h2v2h-2zM19 15h2v4h-2zM15 19h2v2h-2zM19 21h2" />
  </Icon>
);

export const StoreIcon = (properties: SVGProps<SVGSVGElement>) => (
  <Icon {...properties}>
    <path d="m4 9 1.5-6h13L20 9" />
    <path d="M5 13v8h14v-8" />
    <path d="M3 9a3 3 0 0 0 5 2 3 3 0 0 0 4 0 3 3 0 0 0 4 0 3 3 0 0 0 5-2z" />
  </Icon>
);

export const HistoryIcon = (properties: SVGProps<SVGSVGElement>) => (
  <Icon {...properties}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5M12 7v5l3 2" />
  </Icon>
);

export const TransferIcon = (properties: SVGProps<SVGSVGElement>) => (
  <Icon {...properties}>
    <path d="M5 8h14M15 4l4 4-4 4M19 16H5M9 12l-4 4 4 4" />
  </Icon>
);

export const ScanIcon = (properties: SVGProps<SVGSVGElement>) => (
  <Icon {...properties}>
    <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3M7 12h10" />
  </Icon>
);

export const GiftIcon = (properties: SVGProps<SVGSVGElement>) => (
  <Icon {...properties}>
    <path d="M20 12v9H4v-9M2 7h20v5H2zM12 7v14" />
    <path d="M12 7H7.5a2.5 2.5 0 1 1 2.2-3.7zM12 7h4.5a2.5 2.5 0 1 0-2.2-3.7z" />
  </Icon>
);

export const SettingsIcon = (properties: SVGProps<SVGSVGElement>) => (
  <Icon {...properties}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H3v-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V3h4v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
  </Icon>
);

export const BellIcon = (properties: SVGProps<SVGSVGElement>) => (
  <Icon {...properties}>
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
  </Icon>
);
