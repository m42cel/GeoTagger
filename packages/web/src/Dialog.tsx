import { useCallback, useState, type ReactNode } from 'react';

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel: string;
}

export interface PromptOptions extends ConfirmOptions {
  initial: string;
  /** An error to show under the input, or null when the value can be accepted. */
  validate?: (value: string) => string | null;
}

type Request = (ConfirmOptions | PromptOptions) & { resolve: (value: string | null) => void };

/**
 * In-app stand-ins for `window.confirm` and `window.prompt`, awaited the same way.
 * Render the returned element anywhere in the calling view; it is null while no
 * question is open.
 */
export function useDialog(): {
  dialog: ReactNode;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
} {
  const [request, setRequest] = useState<Request | null>(null);

  const prompt = useCallback(
    (options: PromptOptions) => new Promise<string | null>((resolve) => setRequest({ ...options, resolve })),
    [],
  );
  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setRequest({ ...options, resolve: (value) => resolve(value !== null) })),
    [],
  );

  const close = (value: string | null): void => {
    request?.resolve(value);
    setRequest(null);
  };

  const dialog = request && <Dialog key={request.title} request={request} onClose={close} />;
  return { dialog, confirm, prompt };
}

function Dialog({ request, onClose }: { request: Request; onClose: (value: string | null) => void }) {
  const input = 'initial' in request ? request : null;
  const [value, setValue] = useState(input?.initial ?? '');
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    const problem = input?.validate?.(value) ?? null;
    if (problem !== null) {
      setError(problem);
      return;
    }
    onClose(value);
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose(null);
      }}
    >
      <form className="modal dialog-modal" onSubmit={submit}>
        <h2>{request.title}</h2>
        {request.message && <p className="dialog-message">{request.message}</p>}
        {input && (
          <input
            className="dialog-input"
            value={value}
            autoFocus
            onFocus={(e) => e.target.select()}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
          />
        )}
        {error && <p className="error dialog-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={() => onClose(null)}>
            Cancel
          </button>
          <button type="submit" className="primary" autoFocus={!input}>
            {request.confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
