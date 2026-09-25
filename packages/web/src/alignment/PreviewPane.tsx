import { useEffect, useState } from 'react';
import type { FileRecord } from '@geotagger/shared';

/**
 * The last two photos clicked in the filmstrips, stacked for a direct visual
 * comparison — the same content a strip drag is judged by, held still side by side
 * instead of one click apart. It occupies its space before anything is clicked so
 * picking a photo never shifts the filmstrips underneath it.
 */
export function PreviewPane({
  topFileId,
  bottomFileId,
  fileById,
}: {
  topFileId: number | null;
  bottomFileId: number | null;
  fileById: Map<number, FileRecord>;
}) {
  return (
    <div className="preview-pane">
      <PreviewSlot file={topFileId === null ? null : (fileById.get(topFileId) ?? null)} />
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
