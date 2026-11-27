import type { ReactNode } from 'react';

/** Page transition: a template re-mounts on navigation, so each page enters softly (CSS). */
export default function LocaleTemplate({ children }: { children: ReactNode }) {
  return <div className="lg-page">{children}</div>;
}
