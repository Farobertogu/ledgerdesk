'use client';

import {createContext, useContext, useEffect, useRef} from 'react';

/** Local navigation carries focus only; it holds no record, draft or authority. */
export const ViewNavigation = createContext<{entry: number; returnToList: () => void} | null>(null);

export function useViewBack(onBack: () => void) {
  const navigation = useContext(ViewNavigation);
  return () => { onBack(); navigation?.returnToList(); };
}

/** Focus the mounted view, not a field from a different entry tab. */
export function useViewFocus<T extends HTMLElement>(identity: string) {
  const target = useRef<T>(null);
  const entry = useContext(ViewNavigation)?.entry ?? 0;
  useEffect(() => {
    const element = target.current;
    if (!element || element.getClientRects().length === 0) return;
    element.focus({preventScroll: true});
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const reveal = () => element.scrollIntoView({block: 'nearest', behavior: reduced ? 'auto' : 'smooth'});
    reveal();
    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', reveal, {once: true});
    return () => viewport?.removeEventListener('resize', reveal);
  }, [identity, entry]);
  return target;
}

export function returnFocus(primary: HTMLElement | null, fallback: HTMLElement | null) {
  requestAnimationFrame(() => {
    const visible = (element: HTMLElement | null) => element?.isConnected && element.getClientRects().length > 0;
    if (visible(primary)) primary!.focus();
    else if (visible(fallback)) fallback!.focus();
  });
}
