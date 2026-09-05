import { useEffect, useRef, useState, type ReactNode } from "react";
export function Status({ value }: { value: string }) {
  return (
    <span
      className={`chip ${["complete", "active", "ready"].includes(value) ? "ok" : ["rejected", "blocked"].includes(value) ? "err" : "neutral"}`}
    >
      {value.replaceAll("-", " ")}
    </span>
  );
}
export function Panel({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="card">
      <div className="card-head">
        <h3>{title}</h3>
        {actions}
      </div>
      <div className="card-body">{children}</div>
    </section>
  );
}
export function ErrorNotice({ error }: { error?: string | null }) {
  return error ? (
    <div className="banner err" role="alert">
      {error}
    </div>
  ) : null;
}
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="native-field">
      <span className="lbl">{label}</span>
      {children}
    </label>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
export function useWork() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  return {
    busy,
    error,
    run: async (fn: () => Promise<void>) => {
      setError(null);
      setBusy(true);
      try {
        await fn();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
  };
}
export function useTicker() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((v) => v + 1), 3000);
    return () => clearInterval(id);
  }, []);
  return tick;
}
export function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current?.showModal();
    return () => {
      ref.current?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="native-modal"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div className="card-head">
        <h2>{title}</h2>
        <button className="btn sm" aria-label="Close dialog" onClick={close}>
          ×
        </button>
      </div>
      <div className="card-body">{children}</div>
    </dialog>
  );
}
export function OperationList({ items }: { items: any[] }) {
  return items.length ? (
    <div className="native-list">
      {items.map((o) => (
        <div className="native-row" key={o.id}>
          <div>
            <strong>
              {o.kind} · {o.environment?.toUpperCase()}
            </strong>
            <small>
              {o.error ??
                `${new Date(o.createdAt).toLocaleString()} · ${o.resourceName ?? ""}`}
            </small>
          </div>
          <Status value={o.state} />
        </div>
      ))}
    </div>
  ) : (
    <Empty>No changes yet. Publish an API to get started.</Empty>
  );
}
