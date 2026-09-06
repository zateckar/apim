import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { EmptyState, Link, Notice, Panel, go, useAsync } from "../components";
import { formatAgo, formatDateTime } from "../lib/datetime";
import * as I from "./icons";
import type { Session } from "../App";

/**
 * The bell and the mailbox — two renderings of one feed.
 *
 * The feed is the portal's email outbox for the selected application (`GET /api/notifications`).
 * The bell shows the headline and links to the screen that acts on it; the mailbox shows the whole
 * message. Neither invents an event: if the bell says access was requested, a message saying so was
 * composed, and the mailbox has it.
 *
 * What is *read* is a fact about one person's eyes, so it lives in that person's browser and the
 * control plane stores nothing about it. Read state is per notification id, so an item that appears
 * in both surfaces is read in both, and marking one read does not mark the estate read.
 */

export interface Notification {
  id: string;
  applicationId: string;
  applicationName: string;
  kind: string;
  title: string;
  body: string | null;
  to: string[];
  state: string;
  at: string;
  environment: string | null;
  tone: "ok" | "warn" | "err" | "info";
  href: string | null;
  simulated: boolean;
}

const STORAGE_KEY = "portal-notifications-read";
/**
 * Enough ids that a fortnight of ordinary traffic stays marked, and few enough that the entry can
 * never grow without bound. Trimming oldest-first is safe: an id old enough to fall off the end is
 * older than anything the feed still returns, so it can never come back unread.
 */
const REMEMBER = 500;
const POLL_MS = 60_000;

function loadRead(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
  } catch {
    // A corrupted entry is not worth a broken bell — start again rather than throw on render.
    return [];
  }
}

/**
 * Read state, shared by both surfaces through `storage` and a window event.
 *
 * The `storage` event only fires in *other* tabs, so a same-tab change is announced with a custom
 * event of our own — without it the bell's badge and the mailbox in the same tab drift apart.
 */
const CHANGED = "portal-notifications-read-changed";

export function useReadState() {
  const [read, setRead] = useState<Set<string>>(() => new Set(loadRead()));
  useEffect(() => {
    const sync = () => setRead(new Set(loadRead()));
    window.addEventListener("storage", sync);
    window.addEventListener(CHANGED, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(CHANGED, sync);
    };
  }, []);
  const mark = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const next = [...new Set([...loadRead(), ...ids])].slice(-REMEMBER);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(CHANGED));
  }, []);
  return {
    isRead: useCallback((id: string) => read.has(id), [read]),
    mark,
  };
}

function useFeed(applicationId: string, limit: number, tick: unknown) {
  return useAsync(
    () =>
      applicationId
        ? api.get<{ items: Notification[]; transport: string }>(
            `/api/notifications?applicationId=${encodeURIComponent(applicationId)}&limit=${limit}`,
          )
        : Promise.resolve({ items: [], transport: "simulated" }),
    [applicationId, limit, tick],
  );
}

function toneIcon(tone: Notification["tone"]) {
  if (tone === "ok") return <I.Check size={14} />;
  if (tone === "err") return <I.X size={14} />;
  if (tone === "warn") return <I.Alert size={14} />;
  return <I.Info size={14} />;
}

export function NotificationsBell({
  applicationId,
  tick,
}: {
  applicationId: string;
  tick: number;
}) {
  const [open, setOpen] = useState(false);
  // A minute is the cadence for a background poll; `tick` still refreshes it immediately after
  // anything the user did, so your own action shows up without waiting for the timer.
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setBeat((n) => n + 1), POLL_MS);
    return () => window.clearInterval(timer);
  }, []);
  const feed = useFeed(applicationId, 25, `${tick}:${beat}`);
  const { isRead, mark } = useReadState();
  const items = feed.data?.items ?? [];
  const unread = items.filter((item) => !isRead(item.id));

  const popover = useRef<HTMLDivElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return;
    function outside(event: MouseEvent) {
      const target = event.target as Node | null;
      if (popover.current?.contains(target) || button.current?.contains(target)) return;
      setOpen(false);
    }
    // Also on Escape: a popover that only a click can dismiss is a trap for anybody on a keyboard.
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    }
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <>
      <button
        ref={button}
        className="btn sm notif-btn"
        aria-label={unread.length ? `Notifications, ${unread.length} unread` : "Notifications"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <I.Bell />
        {unread.length > 0 && (
          <span className="notif-badge">{unread.length > 99 ? "99+" : unread.length}</span>
        )}
      </button>
      {open && (
        <div className="notif-popover" ref={popover} role="dialog" aria-label="Notifications">
          <div className="notif-head">
            <h3>Notifications</h3>
            <button
              type="button"
              className="btn sm"
              disabled={unread.length === 0}
              onClick={() => mark(items.map((item) => item.id))}
            >
              Mark all read
            </button>
          </div>
          <div className="notif-body">
            <Notice kind="error">{feed.error}</Notice>
            {!feed.error && items.length === 0 && (
              <EmptyState
                title="Nothing yet"
                detail="Access requests, decisions and finished deployments arrive here."
                action={<Link to="/mail">Open Mail →</Link>}
              />
            )}
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`notif-item ${isRead(item.id) ? "" : "is-unread"}`}
                onClick={() => {
                  mark([item.id]);
                  setOpen(false);
                  // Nowhere to go is a legitimate answer — "your deployment finished" is complete
                  // as a sentence — and the row is still worth marking read.
                  if (item.href) go(item.href);
                }}
              >
                <span className={`notif-ic notif-ic-${item.tone}`}>{toneIcon(item.tone)}</span>
                <span className="notif-text">
                  <span className="notif-title">{item.title}</span>
                  <span className="notif-meta">
                    {item.environment && (
                      <span className="chip">{item.environment.toUpperCase()}</span>
                    )}
                    <span className="notif-when">{formatAgo(item.at)}</span>
                  </span>
                </span>
              </button>
            ))}
          </div>
          <div className="notif-head">
            <span className="muted">Delivery is simulated.</span>
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                setOpen(false);
                go(`/${applicationId}/mail`);
              }}
            >
              Open mailbox
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * The mailbox: the same feed with the message shown rather than summarised, and the row's own
 * state on it. `queued` means the outbox has it and the simulated transport has not run yet.
 */
export function Mailbox({ session: s, tick }: { session: Session; tick: number }) {
  const feed = useFeed(s.application, 200, tick);
  const { isRead, mark } = useReadState();
  const items = feed.data?.items ?? [];
  const unread = items.filter((item) => !isRead(item.id));
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <Panel
      title={`Mail for ${s.applicationName(s.application)}`}
      actions={
        <div className="native-actions">
          <span className="chip">{unread.length} unread</span>
          <button
            className="btn sm"
            disabled={unread.length === 0}
            onClick={() => mark(items.map((item) => item.id))}
          >
            Mark all read
          </button>
        </div>
      }
    >
      <p className="muted">
        Every message this portal sent about {s.applicationName(s.application)} — access asked for,
        access decided, deployments that finished. The transport is simulated in this phase: the
        message was composed and addressed, and no mail server was contacted.
      </p>
      <Notice kind="error">{feed.error}</Notice>
      {!feed.error && items.length === 0 && (
        <EmptyState
          title="No mail yet"
          detail="Requesting access to a product, or answering somebody else's request, sends the first message."
          action={<Link to="/catalog">Find an API to subscribe to →</Link>}
        />
      )}
      <div className="notif-body">
        {items.map((item) => {
          const expanded = openId === item.id;
          return (
            <div key={item.id}>
              <button
                type="button"
                className={`notif-item ${isRead(item.id) ? "" : "is-unread"}`}
                aria-expanded={expanded}
                onClick={() => {
                  mark([item.id]);
                  setOpenId(expanded ? null : item.id);
                }}
              >
                <span className={`notif-dot ${isRead(item.id) ? "read" : ""}`} />
                <span className={`notif-ic notif-ic-${item.tone}`}>{toneIcon(item.tone)}</span>
                <span className="notif-text">
                  <span className="notif-title">{item.title}</span>
                  <span className="notif-meta">
                    {item.environment && (
                      <span className="chip">{item.environment.toUpperCase()}</span>
                    )}
                    <span className={`chip ${item.state === "delivered" ? "ok" : "warn"}`}>
                      {item.state === "delivered" ? "sent" : item.state}
                    </span>
                    <span className="notif-when">{formatDateTime(item.at)}</span>
                  </span>
                </span>
              </button>
              {expanded && (
                <div className="notif-message">
                  <div className="kv-list">
                    <div className="kv">
                      <span className="k">To</span>
                      <span className="v">
                        {item.to.length ? item.to.join(", ") : "not addressed yet"}
                      </span>
                    </div>
                    <div className="kv">
                      <span className="k">About</span>
                      <span className="v">{item.kind}</span>
                    </div>
                  </div>
                  <p>{item.body || "This message carried no body beyond its subject line."}</p>
                  {item.href && (
                    <button className="btn sm" onClick={() => go(item.href!)}>
                      Go to the screen that acts on this
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
