import { useEffect, useState } from "react";

/** True below the desktop breakpoint (1024 px). jsdom without matchMedia → desktop. */
export function useIsNarrow(): boolean {
  const query = "(max-width: 1023px)";
  const get = () => typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [narrow, setNarrow] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}
