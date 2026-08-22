// Tracks the mobile/desktop breakpoint; the app renders two different shells.

import { useEffect, useState } from "react";

export function useIsMobileBreakpoint() {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return isMobile;
}
