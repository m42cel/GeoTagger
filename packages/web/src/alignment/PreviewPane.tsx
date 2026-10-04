import { useEffect, useState } from 'react';
import type { FileRecord } from '@geotagger/shared';

/**
 * The last two photos clicked in the filmstrips, stacked for a direct visual
 * comparison — the same content a strip drag is judged by, held still side by side
 * instead of one click apart. It occupies its space before anything is clicked so
 * picking a photo never shifts the filmstrips underneath it.
 *
 * Between the two panes sit the two align buttons (SPEC §6.2, issue #5): rather than
 * zooming far in on one reference photo, then the other, then back out to drag the
 * strips together by hand, a click shifts one strip's offset so the two photos
 * already on screen land on the same instant. A strip with a pinned photo is stretched
 * rather than shifted, and its button says `stretch` (SPEC §4.3).
 */
export function PreviewPane({
  top,
  bottom,
  topVerb,
  bottomVerb,
  onAlignTopToBottom,
  topAlignDisabled,
  topAlignTitle,
  onAlignBottomToTop,
  bottomAlignDisabled,
  bottomAlignTitle,
}: {
  top: FileRecord | null;
  bottom: FileRecord | null;
  topVerb: 'align' | 'stretch';
  bottomVerb: 'align' | 'stretch';
  onAlignTopToBottom: () => void;
  topAlignDisabled: boolean;
  topAlignTitle: string;
  onAlignBottomToTop: () => void;
  bottomAlignDisabled: boolean;
  bottomAlignTitle: string;
}) {
  return (
    <div className="preview-pane">
      <PreviewSlot file={top} />
      <div className="preview-align">
        <button
          type="button"
          className={`ghost${topVerb === 'stretch' ? ' stretch' : ''}`}
          disabled={topAlignDisabled}
          title={topAlignTitle}
          onClick={onAlignTopToBottom}
        >
          ↓ {topVerb} top to bottom
        </button>
        <button
          type="button"
          className={`ghost${bottomVerb === 'stretch' ? ' stretch' : ''}`}
          disabled={bottomAlignDisabled}
          title={bottomAlignTitle}
          onClick={onAlignBottomToTop}
        >
          ↑ {bottomVerb} bottom to top
        </button>
      </div>
      <PreviewSlot file={bottom} />
    </div>
  );
}

function PreviewSlot({ file }: { file: FileRecord | null }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [file?.id]);

  if (file === null) {
    return <div className="preview-slot empty muted">click a photo</div>;
  }
  if (failed) {
    return <div className="preview-slot empty muted">no preview</div>;
  }
  return (
    <div className="preview-slot">
      <img src={`/api/files/${file.id}/preview`} alt={file.filename} title={file.relPath} onError={() => setFailed(true)} />
    </div>
  );
}
