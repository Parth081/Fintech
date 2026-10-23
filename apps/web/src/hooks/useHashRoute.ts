import { useEffect, useState } from 'react';
import { parseHash, type View } from '../lib/route';

export function useHashRoute(fallback: View = 'live'): View {
  const [view, setView] = useState<View>(() => parseHash(window.location.hash, fallback));
  useEffect(() => {
    const on = () => setView(parseHash(window.location.hash, fallback));
    on();
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, [fallback]);
  return view;
}
