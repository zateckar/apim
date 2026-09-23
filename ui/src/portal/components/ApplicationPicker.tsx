import { useEffect, useRef, useState } from "react";
import type { Application } from "../../App";
import { EmptyState, Link } from "../../components";
import * as I from "../icons";

/**
 * Which application you are acting as.
 *
 * This is the most consequential control in the shell — it decides whose APIs you are editing and
 * whose name goes on a subscription request — so it is a real menu with a swatch, a search box and
 * a checkmark rather than a bare `<select>`. Selecting one is **context, not authority**: the
 * server re-derives what you may do from the session on every request, and this list only ever
 * offers applications you are a member of (or, for an administrator, all of them).
 *
 * Names are uppercased in CSS rather than in the string. Applications register as `EAI`, `Skoda Auto` and
 * `mvis`, and a picker that showed all three as written reads as three different kinds of thing;
 * the underlying value keeps its own case so search and routing are unaffected.
 */
export function ApplicationPicker({
  applications,
  value,
  onChange,
}: {
  /** Already filtered to what this caller may act as. */
  applications: Application[];
  value: string;
  onChange: (applicationId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || document.activeElement?.tagName === "INPUT") return;
      const options = Array.from(box.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
      if (!options.length) return;
      event.preventDefault();
      const index = options.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      options[next]?.focus();
    };
    if (applications.length <= 6) box.current?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"], [role="option"]')?.focus();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = applications.find((application) => application.id === value);
  const term = search.trim().toLowerCase();
  // Both the name and the id, because half the estate refers to an application by its slug.
  const matching = term
    ? applications.filter(
        (a) => a.name.toLowerCase().includes(term) || a.id.toLowerCase().includes(term),
      )
    : applications;

  // Nothing to pick: say so where the picker would be, with the one place that explains it. It was a
  // disabled button reading "No application", so a newcomer saw a control that did nothing and no
  // reason why — and the empty state inside its menu could never be opened to read.
  if (applications.length === 0) {
    return (
      <div className="app-picker">
        <span className="app-picker-label">Application</span>
        <p className="app-picker-none">
          You are not in an application yet.
          <br />
          <Link to="/account">See your account →</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="app-picker" ref={box}>
      <span className="app-picker-label">Application</span>
      <button
        className="app-picker-btn"
        ref={trigger}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Application"
        onClick={() => {
          setOpen(!open);
          setSearch("");
        }}
      >
        <span className="swatch">{initialsOf(current?.name ?? "")}</span>
        <span className="meta">
          <span className="t">{current?.name ?? "No application"}</span>
          {current?.leanixId && <span className="app-leanix">LeanIX: {current.leanixId}</span>}
        </span>
        <I.ChevDown size={14} className="chev" />
      </button>
      {open && (
        <div className="app-picker-menu" role="listbox" aria-label="Applications">
          {/* The search box appears once the list is long enough to need it. Below that it is one
              more thing to tab past on the way to a list you can already see all of. */}
          {applications.length > 6 && (
            <div className="search">
              <input
                autoFocus
                aria-label="Search applications"
                placeholder="Search applications…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          )}
          {matching.length === 0 && (
            <EmptyState
              title={`Nothing matches “${search}”`}
              detail="The search covers the applications you are a member of."
              action={
                <button className="btn sm" onClick={() => setSearch("")}>
                  Clear the search
                </button>
              }
            />
          )}
          {matching.map((application) => (
            <button
              key={application.id}
              role="option"
              aria-selected={application.id === value}
              className={`opt ${application.id === value ? "active" : ""}`}
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
                onChange(application.id);
              }}
            >
              <span className="swatch">{initialsOf(application.name)}</span>
              {/* The same two-line `meta` the closed button uses, so a name and its LeanIX id stack
                  the same way in both places rather than depending on which one you are looking at. */}
              <span className="meta">
                <span className="n">{application.name}</span>
                {application.leanixId && <span className="app-leanix">LeanIX: {application.leanixId}</span>}
              </span>
              {application.id === value && <I.Check size={13} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function initialsOf(name: string): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (words.length === 0) return "—";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}
