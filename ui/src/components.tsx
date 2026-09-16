import { Children, cloneElement, isValidElement, type ReactElement, useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ApiError } from "./api";
import { bySeverity, labelFor, severityTone, SEVERITY_LABEL, type AttentionRow } from "./lib/attention";
import { define } from "./lib/glossary";
import type { Permission } from "./lib/capabilities";
import { operationChip, type Chip as StatusChipModel } from "./lib/status";
import { formatDateTime } from "./lib/datetime";

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

export function Link({ to, children, className, ariaLabel }: { to: string; children: ReactNode; className?: string; ariaLabel?: string }) {
  return (
    <a
      href={to}
      className={className}
      aria-label={ariaLabel}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
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

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], scope?: unknown): Async<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cause, setCause] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  // A changed query must not label the previous result as its own. Background refreshes within
  // one scope retain their data; see portal-shell-navigation, asynchronous context changes.
  const [loadedScope, setLoadedScope] = useState<unknown>(scope);

  useEffect(() => {
    let live = true;
    setLoading(true);
    fn()
      .then((result) => {
        if (!live) return;
        setData(result);
        setError(null);
        setCause(null);
        setLoadedScope(scope);
      })
      .catch((err) => {
        if (!live) return;
        setError(describe(err));
        setCause(err);
        setData(null);
        setLoadedScope(scope);
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, scope]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const current = Object.is(scope, loadedScope);
  return { data: current ? data : null, error: current ? error : null, cause: current ? cause : null, loading: loading || !current, reload };
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

/**
 * A titled section of a screen: the estate's only one.
 *
 * There were two of these as well, and unlike the other pairs they were not merely two names.
 * `Panel` wrapped its children in `.card-head` and `.card-body`; `Card` put them straight into
 * `.card`, which is why `styles.css` gave the bare `.card` selector a padding of its own. Both
 * selectors were global and both stylesheets were loaded, so **every `Panel` in the portal carried
 * that padding as well as its head's and its body's** — the head's bottom rule was inset twenty
 * pixels from the card it was supposed to divide, and `overflow: hidden` hid the evidence. Nobody
 * could have found that in a diff; it took looking at a screen.
 *
 * One shape now — `.card` › optional `.card-head` › `.card-body` — so the outer element carries no
 * padding of its own, the rule reaches both edges, and a section looks the same in the branded
 * shell and in a `plainChrome` screen. `hint` sits at the top of the body rather than in the head,
 * because a hint here is often a whole sentence and the head is a bar with actions in it.
 */
export function Panel({
  title,
  hint,
  actions,
  className,
  flush,
  children,
}: {
  title?: string;
  /** One line under the title saying what the section is for. */
  hint?: string;
  /** The controls that belong to this section, drawn at the far end of its head. */
  actions?: ReactNode;
  /** An extra class on the section, for the few that the stylesheet styles by name. */
  className?: string;
  /** The body carries no padding, for a table that should reach the card's own edges. */
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={className ? `card ${className}` : "card"}>
      {(title || actions) && (
        <div className="card-head">
          {title && <h3>{title}</h3>}
          {actions}
        </div>
      )}
      <div className={flush ? "card-body flush" : "card-body"}>
        {hint && <p className="hint">{hint}</p>}
        {children}
      </div>
    </section>
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
  const id = useId();
  return (
    <label className="native-field">
      <span id={`${id}-label`} className="lbl">{label}</span>
      {Children.map(children, child => {
        if (!isValidElement(child) || !["input", "select", "textarea"].includes(String(child.type))) return child;
        const control = child as ReactElement<Record<string, unknown>>;
        return cloneElement(control, {
          "aria-labelledby": control.props["aria-labelledby"] ?? (control.props["aria-label"] ? undefined : `${id}-label`),
          "aria-describedby": [control.props["aria-describedby"], hint ? `${id}-hint` : null].filter(Boolean).join(" ") || undefined,
        });
      })}
      {hint && <span id={`${id}-hint`} className="hint">{hint}</span>}
    </label>
  );
}

/**
 * The shorthand: a labelled text or number input, in the row-flowing chrome the plainer screens
 * lay their forms out in. The generated id is not decoration — the label used to sit *beside* the
 * input rather than name it, so a screen reader announced an unlabelled box.
 */
export function TextField({
  label, value, onChange, placeholder, type = "text", inputId,
  hint, error, required, pattern, min, max, step, maxLength, autoComplete,
}: {
  label: string;
  value: string | number;
  onChange: (next: string) => void;
  placeholder?: string;
  type?: "text" | "number" | "email" | "url" | "password";
  inputId?: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  pattern?: string;
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  autoComplete?: string;
}) {
  const generated = useId();
  const id = inputId ?? generated;
  return (
    <div className={`field${type === "number" ? " field-number" : ""}`}>
      <label htmlFor={id}>{label}</label>
      <input id={id} type={type} value={value} placeholder={placeholder}
        required={required} pattern={pattern} min={min} max={max} step={step}
        maxLength={maxLength} autoComplete={autoComplete}
        aria-invalid={Boolean(error)} aria-describedby={error || hint ? `${id}-help` : undefined}
        onChange={(event) => onChange(event.target.value)} />
      {(error || hint) && <span id={`${id}-help`} className={error ? "field-error" : "hint"}>{error || hint}</span>}
    </div>
  );
}

/** Small exclusive choices stay visible and use native radio keyboard behaviour. */
export function ChoiceField({ label, value, onChange, options, disabled, hint }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  disabled?: boolean;
  hint?: string;
}) {
  const id = useId();
  return <fieldset className="choice-field" disabled={disabled} aria-describedby={hint ? `${id}-help` : undefined}>
    <legend>{label}</legend>
    <div className="choice-options">{options.map(option => <label key={option.value} className={value === option.value ? "choice-option selected" : "choice-option"}>
      <input type="radio" name={id} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
      <span>{option.label}</span>
    </label>)}</div>
    {hint && <p id={`${id}-help`} className="hint">{hint}</p>}
  </fieldset>;
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
    <div className="envpicker" role="group" aria-label="Environment">
      {chain.map((environment) => (
        <button
          key={environment}
          className={environment === value ? "env active" : "env"}
          aria-pressed={environment === value}
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
      {/* `btn` is not the caller's to remember. It defaulted to no class at all, so both callers
          rendered a bare user-agent button: the danger zone's confirmation and the products
          screen's save were the only two controls in the portal that were not house buttons. The
          caller adds the modifier — `danger`, `primary` — and the base is always here. */}
      <button
        className={`btn ${className}`.trim()}
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

/** While something is converging on the gateways, which is the only thing worth watching closely. */
export const TICK_BUSY_MS = 3000;
/** Nothing in flight. Slow enough that a hundred idle tabs are not a load test of our own making. */
export const TICK_IDLE_MS = 30000;

/**
 * How long the shell's clock waits, or `null` for "do not run at all".
 *
 * A decision rather than three numbers inlined in an effect, so `components.test` can state it:
 * hidden means no clock, converging means the fast one, and idle means a cadence an order of
 * magnitude slower than that.
 */
export function tickIntervalMs(busy: boolean, hidden: boolean): number | null {
  if (hidden) return null;
  return busy ? TICK_BUSY_MS : TICK_IDLE_MS;
}

/**
 * The shell's clock. A screen that has to re-read after somebody's action depends on it.
 *
 * It used to be a flat three seconds, always, in every tab. Almost every screen takes the tick as a
 * query dependency — the catalogue re-reads `/api/resources`, `/api/subscriptions` and
 * `/api/products` on it, the shell re-reads `/api/operations`, the bell re-reads
 * `/api/notifications` — so one open portal was five requests every three seconds whether or not
 * anything on the server had changed, and a hundred of them was a load test we were running against
 * ourselves.
 *
 * Two things fix that without giving up the property the ticker exists for.
 *
 *  - **The cadence follows the work.** Three seconds while an operation is still reaching the
 *    gateways, because watching a promotion converge is the case this clock was written for; thirty
 *    seconds when nothing is in flight, because then it is only catching a change somebody else
 *    made.
 *  - **A hidden tab has no clock at all.** A background tab is nobody watching, and it re-reads once
 *    on the way back rather than accumulating the ticks it slept through.
 *
 * The catch-up on return is **owed**, not automatic: it fires only when the interval would already
 * have elapsed. Visibility is noisier than it looks — alt-tabbing, a second monitor and an embedded
 * preview pane can flip it several times a minute — and a tick per flip would put the storm back,
 * on exactly the machines least likely to notice.
 *
 * A screen that needs its own data back *now* still calls `reload()` on its own query; the ticker
 * has never been the mechanism for that.
 */
export function useTicker(busy = false) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | undefined;
    let last = Date.now();
    const fire = () => {
      last = Date.now();
      setTick((value) => value + 1);
    };
    const stop = () => {
      if (id !== undefined) clearInterval(id);
      id = undefined;
    };
    const start = () => {
      stop();
      const every = tickIntervalMs(busy, document.hidden);
      if (every === null) return;
      id = setInterval(fire, every);
    };
    const onVisibility = () => {
      const every = tickIntervalMs(busy, document.hidden);
      // Only what the tab actually missed. Without any catch-up a tab left for an hour shows an
      // hour-old estate until the first interval elapses; with one per flip, a window that keeps
      // losing focus re-reads continuously.
      if (every !== null && Date.now() - last >= every) fire();
      start();
    };
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [busy]);
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
                `${formatDateTime(operation.createdAt)} · ${operation.resourceName ?? ""}`}
            </small>
          </div>
          <StatusChip chip={operationChip(operation.state)} />
        </div>
      ))}
    </div>
  );
}
