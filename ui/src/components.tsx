import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ApiError } from "./api";
import { bySeverity, labelFor, severityTone, SEVERITY_LABEL, type AttentionRow } from "./lib/attention";
import { define } from "./lib/glossary";
import type { Permission } from "./lib/capabilities";
import type { Chip as StatusChipModel } from "./lib/status";

/** Minimal pushState navigation (design section 14 keeps the SPA's routing style). */
let navigator: (to: string) => void = () => {};
export function setNavigator(fn: (to: string) => void) {
  navigator = fn;
}
export function go(to: string) {
  navigator(to);
}

export function usePath(): string {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    setNavigator((to) => {
      window.history.pushState({}, "", to);
      setPath(to);
    });
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return path;
}

export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return (
    <a
      href={to}
      className={className}
      onClick={(event) => {
        event.preventDefault();
        go(to);
      }}
    >
      {children}
    </a>
  );
}

export interface Async<T> {
  data: T | null;
  error: string | null;
  /** The thrown value behind `error`, so a caller can read the problem document's `fix`. */
  cause: unknown;
  loading: boolean;
  reload: () => void;
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): Async<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cause, setCause] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    fn()
      .then((result) => {
        if (!live) return;
        setData(result);
        setError(null);
        setCause(null);
      })
      .catch((err) => {
        if (!live) return;
        setError(describe(err));
        setCause(err);
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, cause, loading, reload };
}

export function describe(err: unknown): string {
  if (err instanceof ApiError) return `${err.status} ${err.title}: ${err.detail}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * The one banner. There were two — `Notice kind="error"` in the plainer screens and `ErrorNotice
 * error={…}` in the branded ones — which meant the same failure was a pastel box on one screen and
 * a themed banner on the next, and only one of them announced itself.
 *
 * `.banner` rather than `.notice` because its four tones are CSS variables, so dark mode falls out
 * for free; `role="alert"` on an error, because a message that appears after a failed request is
 * exactly the case assistive technology has to be told about.
 *
 * Renders nothing for empty children, so `<Notice kind="error">{action.error}</Notice>` is safe to
 * leave in the tree unconditionally — which is what makes the "every error is rendered" rule in
 * `hygiene.test.ts` cheap to obey.
 */
export function Notice({
  kind,
  children,
}: {
  kind: "error" | "warn" | "ok" | "info";
  children: ReactNode;
}) {
  if (!children) return null;
  return (
    <div className={`banner ${kind === "error" ? "err" : kind}`} role={kind === "error" ? "alert" : undefined}>
      {children}
    </div>
  );
}

export function Card({ title, hint, children }: { title?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="card">
      {title && <h3>{title}</h3>}
      {hint && <p className="hint">{hint}</p>}
      {children}
    </div>
  );
}

/**
 * A labelled control — the label, and whatever the caller puts under it.
 *
 * This and `TextField` below were both called `Field`, in two modules, with prop sets that had
 * nothing in common: one took `children`, the other took `value` and `onChange`. Which one a screen
 * got depended on which module it happened to import. They are two components and now they have two
 * names, because a select, a textarea and a group of radios all need a label and only one of them
 * is an `<input type="text">`.
 *
 * Reach for this one by default; `TextField` is the shorthand for the case it covers.
 */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  /** One line under the control, for the thing the label has no room to say. */
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="native-field">
      <span className="lbl">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

/**
 * The shorthand: a labelled text or number input, in the row-flowing chrome the plainer screens
 * lay their forms out in. The generated id is not decoration — the label used to sit *beside* the
 * input rather than name it, so a screen reader announced an unlabelled box.
 */
export function TextField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string | number;
  onChange: (next: string) => void;
  placeholder?: string;
  type?: "text" | "number";
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function Digest({ value }: { value?: string | null }) {
  if (!value) return <span className="muted">—</span>;
  return (
    <span className="mono" title={value}>
      {value.replace("sha256:", "").slice(0, 12)}
    </span>
  );
}

/**
 * The environment switcher. Everything in design section 6.1's edited-in-place tier — policy,
 * routes, bindings, subscriptions — is per environment, so almost every screen needs to say
 * which one it is showing.
 */
export function EnvironmentPicker({
  chain,
  value,
  onChange,
}: {
  chain: string[];
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="envpicker">
      {chain.map((environment) => (
        <button
          key={environment}
          className={environment === value ? "env active" : "env"}
          onClick={() => onChange(environment)}
        >
          {environment}
        </button>
      ))}
    </div>
  );
}

export function Pill({ kind, children }: { kind: string; children: ReactNode }) {
  return <span className={`pill ${kind}`}>{children}</span>;
}

/**
 * A stacked bar per minute. Twenty lines of SVG rather than a charting dependency — the shape of
 * a rate-limit change over a minute is all this has to show.
 */
export function StackedBars({
  rows,
  height = 64,
}: {
  rows: Array<{ label: string; ok: number; rejected: number; upstream: number }>;
  height?: number;
}) {
  if (rows.length === 0) return <p className="muted">No traffic in this window.</p>;
  const max = Math.max(1, ...rows.map((r) => r.ok + r.rejected + r.upstream));
  const width = Math.max(rows.length * 8, 120);
  const barWidth = width / rows.length;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="chart" preserveAspectRatio="none">
      {rows.map((row, index) => {
        const scale = (n: number) => (n / max) * height;
        const okHeight = scale(row.ok);
        const rejectedHeight = scale(row.rejected);
        const upstreamHeight = scale(row.upstream);
        const x = index * barWidth;
        let y = height;
        const parts: ReactNode[] = [];
        for (const [value, className] of [
          [okHeight, "bar-ok"],
          [rejectedHeight, "bar-rejected"],
          [upstreamHeight, "bar-upstream"],
        ] as const) {
          if (value <= 0) continue;
          y -= value;
          parts.push(
            <rect key={className} x={x + 0.5} y={y} width={Math.max(1, barWidth - 1)} height={value} className={className} />,
          );
        }
        return (
          <g key={row.label}>
            <title>{`${row.label}: ${row.ok} ok, ${row.rejected} rejected, ${row.upstream} upstream errors`}</title>
            {parts}
          </g>
        );
      })}
    </svg>
  );
}

// --------------------------------------------------------------------------- v4: the vocabulary

/**
 * A domain word with its definition attached (plan §9.4). Rendered as a dotted underline with the
 * sentence as its title, so the meaning is one hover away everywhere the word appears — and the
 * "How this works" page renders the same table, so the two cannot drift.
 */
export function Term({ name, children }: { name: string; children?: ReactNode }) {
  const entry = define(name);
  if (!entry) return <>{children ?? name}</>;
  return (
    <abbr className="term" title={entry.definition}>
      {children ?? entry.term}
    </abbr>
  );
}

/** The one producer of a status chip: `lib/status.ts` decides the words, this draws them. */
export function StatusChip({ chip }: { chip: StatusChipModel | null }) {
  if (!chip) return null;
  return (
    <span className={`chip-status tone-${chip.tone}`} title={chip.title}>
      {chip.label}
    </span>
  );
}

/**
 * An action the caller may not be able to perform. **Disabled with the reason beside it, never
 * hidden** (plan §9.4): a hidden control teaches nothing, and the reader concludes the feature
 * does not exist rather than learning who to ask.
 */
export function Action({
  permission,
  onClick,
  children,
  className = "",
  busy,
}: {
  permission: Permission;
  onClick: () => void;
  children: ReactNode;
  className?: string;
  busy?: boolean;
}) {
  return (
    <span className="action">
      <button
        className={className}
        disabled={!permission.enabled || busy}
        title={permission.reason ?? undefined}
        onClick={onClick}
      >
        {children}
      </button>
      {permission.reason && <span className="action-reason">{permission.reason}</span>}
    </span>
  );
}

/**
 * An empty list, with the thing to do about it. Every empty state names the next action (plan
 * §9.4): "no results" is a dead end, and a dead end on a first visit is where people give up.
 *
 * This is the only empty state. The branded screens had an `Empty` of their own that took bare
 * children and carried no action — which is to say it was the same box with the rule switched off,
 * and `hygiene.test.ts` could only enforce the rule over half the interface. Anything that turned
 * out not to be an empty state when it was converted became what it actually was: a `Skeleton`
 * while something loads, a `Notice` when the sentence explains rather than invites.
 */
export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      <p>{detail}</p>
      {action}
    </div>
  );
}

/**
 * The attention list (plan §6.3). One component for the dashboard's blocks, the API page's banner
 * and the first-run panel, because they are the same rows: the control plane writes the sentence,
 * `lib/attention.ts` supplies the short label and the call to action.
 */
export function AttentionList({
  rows,
  truncated = 0,
  more,
}: {
  rows: AttentionRow[];
  truncated?: number;
  more?: ReactNode;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="attention">
      {bySeverity(rows).map((group) => (
        <div key={group.severity} className={`attention-group sev-${group.severity}`}>
          <h4>{SEVERITY_LABEL[group.severity]}</h4>
          <ul className="plain">
            {group.rows.map((row, index) => {
              const label = labelFor(row.code);
              return (
                <li key={`${row.code}-${row.subject.id}-${row.environment ?? ""}-${index}`}>
                  <span className={`chip-status tone-${severityTone(row.severity)}`}>{label.title}</span>{" "}
                  <strong>{row.subject.name}</strong>
                  {row.environment && <span className="pill muted">{row.environment}</span>}
                  <div className="attention-detail">
                    {row.detail} <Link to={row.href}>{label.action}</Link>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {truncated > 0 && (
        <p className="muted small">
          {truncated} more not shown. {more}
        </p>
      )}
    </div>
  );
}

/** The wizard stepper: where you are, what is behind you, and what is still to come. */
export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="stepper">
      {steps.map((step, index) => (
        <li
          key={step}
          className={index === current ? "current" : index < current ? "done" : "todo"}
          aria-current={index === current ? "step" : undefined}
        >
          <span className="step-number">{index + 1}</span>
          {step}
        </li>
      ))}
    </ol>
  );
}

/**
 * Nothing destructive without a typed confirmation (plan §9.4).
 *
 * A native `confirm()` is one keystroke from "yes" and says nothing about consequences; this asks
 * for the object's own name, which cannot be answered by muscle memory. The sentence above the box
 * says what stops working and when — the *when* matters here, because most of these take effect at
 * the next gateway poll rather than instantly.
 */
export function DangerZone({
  what,
  name,
  consequence,
  permission,
  busy,
  error,
  onConfirm,
}: {
  /** The verb and object, as a button label: "Delete this API". */
  what: string;
  /** What must be typed back. */
  name: string;
  consequence: string;
  permission: Permission;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  return (
    <details className="danger-zone">
      <summary className="muted small">{what}</summary>
      <p className="muted small">
        {consequence} Type <strong>{name}</strong> to confirm.
      </p>
      <Notice kind="error">{error}</Notice>
      <div className="row">
        <div className="field">
          <label htmlFor={`confirm-${name}`}>Name</label>
          <input
            id={`confirm-${name}`}
            value={typed}
            placeholder={name}
            disabled={!permission.enabled}
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
        <Action
          permission={permission}
          busy={busy || typed !== name}
          className="danger"
          onClick={onConfirm}
        >
          {what}
        </Action>
      </div>
    </details>
  );
}

/** A grey block the size of the thing that is coming, so the layout does not jump. */
export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton-row" />
      ))}
    </div>
  );
}

/** Buttons that run an async action, disable themselves and surface the failure inline. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cause, setCause] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);

  const run = useCallback(async (fn: () => Promise<unknown>, okMessage?: string) => {
    setBusy(true);
    setError(null);
    setCause(null);
    setMessage(null);
    try {
      await fn();
      if (okMessage) setMessage(okMessage);
      return true;
    } catch (err) {
      setError(describe(err));
      setCause(err);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, error, cause, message, run, setError, setMessage };
}

// ------------------------------------------------------------------ moved in from portal/common

/**
 * A titled section, with somewhere to put the controls that belong to it.
 *
 * `Card` above is the same idea in the plainer chrome, and the two have not been merged: `Card`
 * puts its children straight into `.card` while this wraps them in `.card-body`, so folding one
 * into the other would re-pad seventy-nine screens that nobody would have looked at afterwards.
 * Use `Panel` in the branded shell and `Card` in a `plainChrome` screen.
 */
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

/**
 * A raw workflow state as a chip: what an operation, a subscription or a grant is currently doing.
 *
 * `StatusChip` above draws a `lib/status.ts` model, which is the one that names a state by what it
 * means to the reader. This one maps the column value straight through, and is for the states that
 * vocabulary does not cover yet.
 */
export function Status({ value }: { value: string }) {
  const tone = ["complete", "active", "ready"].includes(value)
    ? "ok"
    : ["rejected", "blocked"].includes(value)
      ? "err"
      : "neutral";
  return <span className={`chip ${tone}`}>{value.replaceAll("-", " ")}</span>;
}

/**
 * A modal dialog. Native `<dialog>`, so Escape, the backdrop and the focus trap are the browser's
 * rather than ours — and focus goes back where it came from on close, which is the part hand-rolled
 * modals forget.
 */
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
      onCancel={(event) => {
        event.preventDefault();
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

/** The shell's clock. A screen that has to re-read after somebody's action depends on it. */
export function useTicker() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((value) => value + 1), 3000);
    return () => clearInterval(id);
  }, []);
  return tick;
}

/** Changes in flight, and how far each has reached the gateways. */
export function OperationList({ items }: { items: any[] }) {
  if (items.length === 0) {
    return (
      <EmptyState
        title="No changes yet"
        detail="Publishing an API, editing its policy or promoting it into the next environment records a change here, with how far it has reached the gateways."
        action={<Link to="/publish">Publish an API →</Link>}
      />
    );
  }
  return (
    <div className="native-list">
      {items.map((operation) => (
        <div className="native-row" key={operation.id}>
          <div>
            <strong>
              {operation.kind} · {operation.environment?.toUpperCase()}
            </strong>
            <small>
              {operation.error ??
                `${new Date(operation.createdAt).toLocaleString()} · ${operation.resourceName ?? ""}`}
            </small>
          </div>
          <Status value={operation.state} />
        </div>
      ))}
    </div>
  );
}
