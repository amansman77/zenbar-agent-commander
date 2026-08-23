// Closes a dropdown when the user clicks anywhere outside it.
//
// Returns the ref to put on the menu's container. The listener is only
// attached while the menu is open, so a closed menu costs nothing.

import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";

export function useCloseOnOutsideClick(open: boolean, setOpen: Dispatch<SetStateAction<boolean>>) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, setOpen]);

  return ref;
}
