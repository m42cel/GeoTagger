import { useEffect, useState } from 'react';
import type { FileId, FileRecord } from '@geotagger/shared';

/**
 * The last two photos clicked in the filmstrips, stacked for a direct visual
 * comparison — the same content a strip drag is judged by, held still side by side
 * instead of one click apart. It occupies its space before anything is clicked so
 * picking a photo never shifts the filmstrips underneath it.
 *
 * Between the two panes sit the two align buttons (SPEC §6.2, issue #5): rather than
 * zooming far in on one reference photo, then the other, then back out to drag the
 * strips together by hand, a click shifts one strip's offset so the two photos
 * already on screen land on the same instant.
 */
export function PreviewPane({
  topFileId,
  bottomFileId,
  fileById,
  onAlignTopToBottom,
  topAlignDisabled,
  topAlignTitle,
  onAlignBottomToTop,
  bottomAlignDisabled,
  bottomAlignTitle,
}: {
  topFileId: FileId | null;
  bottomFileId: FileId | null;
  fileById: Map<FileId, FileRecord>;
  onAlignTopToBottom: () => void;
  topAlignDisabled: boolean;
  topAlignTitle: string;
  onAlignBottomToTop: () => void;
  bottomAlignDisabled: boolean;
  bottomAlignTitle: string;
}) {
  return (
    <div className="preview-pane">
      <PreviewSlot file={topFileId === null ? null : (fileById.get(topFileId) ?? null)} />
      <div className="preview-align">
        <button type="button" className="ghost" disabled={topAlignDisabled} title={topAlignTitle} onClick={onAlignTopToBottom}>
          ↓ align top to bottom
        </button>
        <button
          type="button"
          className="ghost"
          disabled={bottomAlignDisabled}
          title={bottomAlignTitle}
          onClick={onAlignBottomToTop}
        >
          ↑ align bottom to top
        </button>
      </div>
      <PreviewSlot file={bottomFileId === null ? null : (fileById.get(bottomFileId) ?? null)} />
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
