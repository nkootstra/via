/**
 * The app's glyphs, drawn at `size`: mostly 24-unit stroke icons in Lucide's
 * geometry, and a few filled ones (`Glyph`).
 */
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
  <Glyph {...props}>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M22 8.5C22 12.0899 19.0899 15 15.5 15C14.7504 15 14.0304 14.8731 13.3604 14.6396L11.5858 16.4142C11.2107 16.7893 10.702 17 10.1716 17H9.5C9.22386 17 9 17.2239 9 17.5V18.1716C9 18.702 8.78929 19.2107 8.41421 19.5858L7.58579 20.4142C7.21071 20.7893 6.70201 21 6.17157 21H4C3.44772 21 3 20.5523 3 20V17.8284C3 17.298 3.21071 16.7893 3.58579 16.4142L9.36037 10.6396C9.12689 9.96959 9 9.24962 9 8.5C9 4.91015 11.9101 2 15.5 2C19.0899 2 22 4.91015 22 8.5ZM17 8.5C17 9.32843 16.3284 10 15.5 10C14.6716 10 14 9.32843 14 8.5C14 7.67157 14.6716 7 15.5 7C16.3284 7 17 7.67157 17 8.5Z"
    />
  </Glyph>
);

/** A destructive action's glyph: revoking a key, removing an account. */
export const TrashIcon = (props: IconProps) => (
  <Glyph {...props}>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M7.86847 5H3.25C2.83579 5 2.5 5.33579 2.5 5.75C2.5 6.16421 2.83579 6.5 3.25 6.5H3.99997C3.99999 6.5174 4.00061 6.53492 4.00184 6.55253L4.90696 19.4426C5.00811 20.8831 6.20617 22 7.6502 22H16.3498C17.7938 22 18.9919 20.8831 19.093 19.4426L19.9982 6.55253C19.9994 6.53492 20 6.5174 20 6.5H20.75C21.1642 6.5 21.5 6.16421 21.5 5.75C21.5 5.33579 21.1642 5 20.75 5H16.1315C15.6816 3.13507 14.003 1.75 12 1.75C9.99701 1.75 8.31844 3.13507 7.86847 5ZM9.43728 5H14.5627C14.1628 3.97583 13.1658 3.25 12 3.25C10.8342 3.25 9.83724 3.97583 9.43728 5ZM10 9.75C10.4142 9.75 10.75 10.0858 10.75 10.5V16.25C10.75 16.6642 10.4142 17 10 17C9.58579 17 9.25 16.6642 9.25 16.25V10.5C9.25 10.0858 9.58579 9.75 10 9.75ZM14 9.75C14.4142 9.75 14.75 10.0858 14.75 10.5V16.25C14.75 16.6642 14.4142 17 14 17C13.5858 17 13.25 16.6642 13.25 16.25V10.5C13.25 10.0858 13.5858 9.75 14 9.75Z"
    />
  </Glyph>
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
 * via's mark: one line splitting into two, as one endpoint routes to many
 * accounts and providers.
 */
export function Mark({ size = 24 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect width="24" height="24" rx="7" fill="currentColor" />
      <path
        transform="translate(3 3) scale(0.75)"
        fill="var(--via-background)"
        d="M20.25 3C20.6642 3 21 3.33579 21 3.75V9.25C21 9.66421 20.6642 10 20.25 10C19.8358 10 19.5 9.66421 19.5 9.25V5.56055L13.0605 12L19.5 18.4395V14.75C19.5 14.3358 19.8358 14 20.25 14C20.6642 14 21 14.3358 21 14.75V20.25C21 20.6642 20.6642 21 20.25 21H14.75C14.3358 21 14 20.6642 14 20.25C14 19.8358 14.3358 19.5 14.75 19.5H18.4395L11.6895 12.75H3.75C3.33579 12.75 3 12.4142 3 12C3 11.5858 3.33579 11.25 3.75 11.25H11.6895L18.4395 4.5H14.75C14.3358 4.5 14 4.16421 14 3.75C14 3.33579 14.3358 3 14.75 3H20.25Z"
      />
    </svg>
  );
}

/** A 24-unit filled glyph in the current text colour, drawn at `size`: a brand mark, a key. */
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
