/**
 * Privacy mode: while it is on, the page shows no emails, key endings,
 * addresses or codes, for streaming or sharing the screen. It changes only
 * what is shown; the admin API answers as it always does.
 */
import { useMemo } from "react";
import { maskAddress, maskEmails, maskKeyTail } from "./mask.ts";
import { preference } from "./preference.ts";

const privacy = preference<"off" | "on">(
  "via.privacy",
  (value) => (value === "on" ? "on" : "off"),
  "off",
);

/** Turns privacy mode on or off, here and in the other tabs. */
export const setPrivacy = (on: boolean) => privacy.set(on ? "on" : "off");

/** Whether privacy mode is on. */
export const usePrivacy = () => privacy.use() === "on";

const shown = (value: string) => value;

/** What privacy mode shows in place of a ChatGPT plan. */
const HIDDEN_PLAN = "•••";

/**
 * How to show what may identify the viewer: as it is, or hidden while privacy
 * mode is on. `text` hides the emails in any text, `key` a key's last
 * characters too, `address` an address's host, and `plan` a ChatGPT plan.
 */
export function useMask() {
  const on = usePrivacy();

  return useMemo(
    () =>
      on
        ? {
            on,
            text: maskEmails,
            key: (value: string) => maskKeyTail(maskEmails(value)),
            address: maskAddress,
            plan: () => HIDDEN_PLAN,
          }
        : { on, text: shown, key: shown, address: shown, plan: shown },
    [on],
  );
}
