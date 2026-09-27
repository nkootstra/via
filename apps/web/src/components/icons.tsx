/** The app's glyphs: 24-unit stroke icons in Lucide's geometry, drawn at `size`. */
import type { ReactNode } from "react";

interface IconProps {
  readonly size?: number;
}

function Icon({ size = 16, children }: IconProps & { readonly children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const OverviewIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect width="7" height="9" x="3" y="3" rx="1.5" />
    <rect width="7" height="5" x="14" y="3" rx="1.5" />
    <rect width="7" height="9" x="14" y="12" rx="1.5" />
    <rect width="7" height="5" x="3" y="16" rx="1.5" />
  </Icon>
);

export const AccountsIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </Icon>
);

export const KeyIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4" />
    <path d="m21 2-9.6 9.6" />
    <circle cx="7.5" cy="15.5" r="5.5" />
  </Icon>
);

export const ModelsIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
    <path d="m3.3 7 8.7 5 8.7-5" />
    <path d="M12 22V12" />
  </Icon>
);

export const SignOutIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5" />
    <path d="M21 12H9" />
  </Icon>
);

export const PlusIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </Icon>
);

export const SearchIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Icon>
);

export const MoreIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
    <circle cx="5" cy="12" r="1" />
  </Icon>
);

export const EyeIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);

export const EyeOffIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
    <path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
    <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
    <path d="m2 2 20 20" />
  </Icon>
);

export const ExternalIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M15 3h6v6" />
    <path d="M10 14 21 3" />
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </Icon>
);

const ProviderIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 2v4" />
    <path d="m16.2 7.8 2.9-2.9" />
    <path d="M18 12h4" />
    <path d="m16.2 16.2 2.9 2.9" />
    <path d="M12 18v4" />
    <path d="m4.9 19.1 2.9-2.9" />
    <path d="M2 12h4" />
    <path d="m4.9 4.9 2.9 2.9" />
  </Icon>
);

/**
 * via's mark: three streams merging into one, as it pools accounts behind one
 * endpoint.
 */
export function Mark({ size = 24 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect width="24" height="24" rx="7" fill="currentColor" />
      <g
        stroke="var(--via-background)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      >
        <path d="M6.5 7c3 0 3.5 5 5.5 5" />
        <path d="M6.5 12h5.5" />
        <path d="M6.5 17c3 0 3.5-5 5.5-5" />
        <path d="M12 12h5.5" />
      </g>
      <circle cx="17.75" cy="12" r="1.35" fill="var(--via-background)" />
    </svg>
  );
}

/** A brand mark: a 24-unit filled glyph in the current text colour, drawn at `size`. */
function Glyph({ size = 16, children }: IconProps & { readonly children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      {children}
    </svg>
  );
}

export const CodexIcon = (props: IconProps) => (
  <Glyph {...props}>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M9.37088 2.18576C11.1759 1.70239 13.0087 2.19059 14.3229 3.32227C16.0284 2.99798 17.8626 3.49276 19.1849 4.81496C20.5066 6.13684 21 7.96945 20.6766 9.67409C21.8096 10.9886 22.2977 12.823 21.8141 14.629C21.3301 16.4355 19.9888 17.7788 18.35 18.3506C17.7783 19.9889 16.4362 21.3295 14.6302 21.8138C12.8243 22.2976 10.9899 21.8091 9.67535 20.6763C7.97048 21.0002 6.13741 20.5067 4.81526 19.1846C3.49332 17.8624 2.99758 16.0289 3.32161 14.3235C2.18976 13.0088 1.70243 11.1746 2.18606 9.36962C2.67009 7.56414 4.00987 6.21916 5.64825 5.647C6.22058 4.009 7.56548 2.66963 9.37088 2.18576ZM12.9805 13.4704C12.4393 13.4707 12.0002 13.9097 12.0001 14.4509C12.0001 14.9922 12.4392 15.4311 12.9805 15.4313H15.9219C16.4633 15.4313 16.9023 14.9924 16.9023 14.4509C16.9022 13.9095 16.4633 13.4704 15.9219 13.4704H12.9805ZM9.40918 9.04408C9.13045 8.58016 8.52809 8.42952 8.06394 8.70801C7.60003 8.98663 7.44965 9.5891 7.72787 10.0533L8.89502 11.9998L7.72787 13.9463C7.44943 14.4104 7.60008 15.0128 8.06394 15.2915C8.52819 15.5701 9.13053 15.4196 9.40918 14.9555L10.8798 12.5044C11.0661 12.1939 11.0661 11.8057 10.8798 11.4952L9.40918 9.04408Z"
    />
  </Glyph>
);

const OpenCodeGoIcon = (props: IconProps) => (
  <Glyph {...props}>
    <path opacity="0.4" d="M16 10.0002V18.0002H8V10.0002H16Z" />
    <path fillRule="evenodd" clipRule="evenodd" d="M20 22H4V2H20V22ZM16 6H8V18H16V6Z" />
  </Glyph>
);

/** A provider's mark where via has one, else a generic glyph. */
export const ProviderLogo = ({ name, ...props }: IconProps & { readonly name: string }) =>
  name === "opencode-go" ? <OpenCodeGoIcon {...props} /> : <ProviderIcon {...props} />;
