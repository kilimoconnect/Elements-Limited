"use client";

import * as React from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";

const START = "elements:navigation-start";

/** Tell the progress bar a navigation started (for router.push from code, e.g. a clickable row). */
export function startNavigation() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(START));
}

/**
 * Shows a loading bar and a "Loading…" label as soon as any in-app link is
 * clicked, until the next page is on screen. Links to downloads (/api/…)
 * show "Preparing download…" for a few seconds instead.
 */
export function NavigationProgress() {
  const pathname = usePathname();
  const search = useSearchParams();
  const here = `${pathname}?${search.toString()}`;
  // Started from page `from`; it stops by itself once a different page is on screen.
  const [state, setState] = React.useState<null | { mode: "page" | "download"; from: string }>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // The link or button that was clicked shows its own spinner (CSS .nav-loading).
  const clicked = React.useRef<HTMLElement | null>(null);

  const show = React.useCallback((m: "page" | "download") => {
    setState({ mode: m, from: `${window.location.pathname}?${window.location.search.slice(1)}` });
    if (timer.current) clearTimeout(timer.current);
    // Safety net: never leave the bar running (downloads give no signal when done).
    timer.current = setTimeout(() => setState(null), m === "download" ? 4000 : 15000);
  }, []);
  const mode = state && (state.mode === "download" || state.from === here) ? state.mode : null;
  React.useEffect(() => {
    if (mode || !clicked.current) return;
    clicked.current.classList.remove("nav-loading");
    clicked.current.removeAttribute("aria-busy");
    clicked.current = null;
  }, [mode]);

  React.useEffect(() => {
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.("a");
      if (!a || !a.href || a.target === "_blank") return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      const download = url.pathname.startsWith("/api/") || a.hasAttribute("download");
      if (!download && url.pathname === window.location.pathname && url.search === window.location.search) return;
      clicked.current?.classList.remove("nav-loading");
      a.classList.add("nav-loading"); a.setAttribute("aria-busy", "true");
      clicked.current = a;
      show(download ? "download" : "page");
    }
    const onStart = () => show("page");
    document.addEventListener("click", onClick, true);
    window.addEventListener(START, onStart);
    return () => { document.removeEventListener("click", onClick, true); window.removeEventListener(START, onStart); };
  }, [show]);

  if (!mode) return null;
  return (
    <>
      <div className="fixed inset-x-0 top-0 z-[100] h-1 overflow-hidden bg-primary/15" role="progressbar" aria-label="Loading">
        <div className="h-full w-1/3 animate-[nav-progress_1.1s_ease-in-out_infinite] bg-[hsl(var(--sidebar-accent))]" />
      </div>
      <div className="fixed bottom-4 right-4 z-[100] flex items-center gap-2 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-lg" aria-live="polite">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {mode === "download" ? "Preparing download…" : "Loading…"}
      </div>
    </>
  );
}
