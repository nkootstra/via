/**
 * A viewer preference: one choice this browser remembers in localStorage,
 * applied at once and followed by the other tabs. Its fallback is never
 * stored, so going back to it leaves nothing behind.
 */
import { useSyncExternalStore } from "react";

export function preference<T extends string>(
  key: string,
  parse: (stored: string | null) => T,
  fallback: T,
) {
  const changeEvent = `${key}-change`;

  // Private windows and blocked site data make storage throw; the choice then
  // lasts only as long as the page.
  let unstored = fallback;

  const current = (): T => {
    try {
      return parse(localStorage.getItem(key));
    } catch {
      return unstored;
    }
  };

  const subscribe = (onChange: () => void) => {
    // Another tab chose: follow it here too.
    const onStorage = (event: StorageEvent) => {
      if (event.key === key || event.key === null) onChange();
    };

    window.addEventListener(changeEvent, onChange);
    window.addEventListener("storage", onStorage);

    return () => {
      window.removeEventListener(changeEvent, onChange);
      window.removeEventListener("storage", onStorage);
    };
  };

  return {
    /** The current choice, outside React. */
    get: current,
    /** Chooses `value`: applies it at once and remembers it for the next visit. */
    set: (value: T) => {
      unstored = value;

      try {
        if (value === fallback) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch {
        // Nothing to persist to.
      }

      window.dispatchEvent(new Event(changeEvent));
    },
    /** The current choice; a component using it rerenders only when it changes. */
    use: (): T => useSyncExternalStore(subscribe, current, () => fallback),
  };
}
