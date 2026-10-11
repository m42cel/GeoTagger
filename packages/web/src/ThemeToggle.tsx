import { useEffect, useState } from 'react';

type ThemeMode = 'auto' | 'light' | 'dark';

/** Also read by the inline script in index.html, so the first paint already has the right theme. */
const STORAGE_KEY = 'geotagger.theme';

const NEXT: Record<ThemeMode, ThemeMode> = { auto: 'light', light: 'dark', dark: 'auto' };

const LABEL: Record<ThemeMode, string> = {
  auto: 'Theme: automatic (follows the system)',
  light: 'Theme: light',
  dark: 'Theme: dark',
};

function storedMode(): ThemeMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'auto';
  } catch {
    return 'auto';
  }
}

/** Cycles automatic → light → dark; styles.css keys the dark tokens off `<html data-theme>`. */
export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>(storedMode);

  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // Without storage the choice just lasts until the next reload.
    }
  }, [mode]);

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => setMode(NEXT[mode])}
      aria-label={LABEL[mode]}
      title={LABEL[mode]}
    >
      <ThemeIcon mode={mode} />
    </button>
  );
}

function ThemeIcon({ mode }: { mode: ThemeMode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {mode === 'light' && (
        <>
          <circle cx="12" cy="12" r="5" />
          <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
        </>
      )}
      {mode === 'dark' && <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />}
      {mode === 'auto' && (
        <>
          {/* One disc: the left half a sun with its rays, the right half shaded as a crescent moon. */}
          <path d="M12 6a6 6 0 0 0 0 12" />
          <path d="M12 1v2M12 21v2M1 12h2M4.22 4.22l1.42 1.42M4.22 19.78l1.42-1.42" />
          <path d="M12 6a6 6 0 0 1 0 12a9 9 0 0 0 0-12z" fill="currentColor" />
        </>
      )}
    </svg>
  );
}
