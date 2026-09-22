import { useState } from 'react';
import { formatUtcOffset, parseUtcOffsetMinutes } from '@geotagger/shared';

/**
 * The one-off question of SPEC §4.2.
 *
 * Every file needs a UTC offset before photos and videos can sit on one timeline. It
 * is normally inherited from files that carry both coordinates and a trustworthy
 * clock; when the folder holds none at all there is nothing to inherit from, and the
 * user is asked once rather than having every local time silently treated as UTC.
 */
export function UtcOffsetPrompt({ onAnswer }: { onAnswer: (minutes: number) => void }) {
  const [text, setText] = useState('+02:00');
  const parsed = parseUtcOffsetMinutes(text);

  return (
    <div className="banner warn utc-prompt">
      <p>
        No file in this folder knows its UTC offset, so there is nothing to inherit one from. What
        was the clock set to, relative to UTC?
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (parsed !== null) onAnswer(parsed);
        }}
      >
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="UTC offset"
          placeholder="+02:00"
        />
        <button type="submit" className="primary" disabled={parsed === null}>
          Use {parsed === null ? '…' : formatUtcOffset(parsed)}
        </button>
      </form>
    </div>
  );
}
