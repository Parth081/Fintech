import { useEffect, useState } from 'react';
import { parseHash, type View } from '../lib/route';

export function useHashRoute(): View {
  const [view, setView] = useState<View>(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setView(parseHash(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return view;
}
