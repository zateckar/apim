import { useState } from "react";
import { api, type Subscription, type SubscriptionKey } from "../api";
import { Notice, StatusChip, useAction } from "../components";
import { subscriptionKeyChip } from "../lib/status";

/**
 * A subscription's two keys: how old each one is, when it stops working, and the two things you can
 * do to either of them.
 *
 * One component because there were two, and they had drifted. The subscription's own screen offered
 * both rotations; the subscriptions *list* offered a dialog that could rotate the secondary and
 * nothing else — so the key most callers actually present, the primary issued on day one, could not
 * be replaced from the screen most people opened. Neither showed an age, which is now the point:
 * a key expires, and a screen about keys that does not say how old they are is the screen you find
 * out on.
 *
 * The sequence is what having two slots is *for*, so it is stated rather than implied: rotate the
 * idle slot, move the callers onto it, then rotate the other. A reader who rotates the key their
 * callers are holding has taken an outage to improve their security posture.
 */

/** A control plane older than the per-slot dates sends no `keys`; the buttons still work. */
const UNDATED: SubscriptionKey[] = [
  { which: "primary", mintedAt: null, ageDays: null, expiresAt: null, expiredAt: null, status: "ok" },
  { which: "secondary", mintedAt: null, ageDays: null, expiresAt: null, expiredAt: null, status: "absent" },
];

export function SubscriptionKeys({
  subscription,
  onChanged,
}: {
  subscription: Subscription;
  onChanged: () => void;
}) {
  const action = useAction();
  // Key material, once the reader has asked for it. Never fetched on mount: every reveal is
  // audited, and opening a screen is not asking.
  const [values, setValues] = useState<Partial<Record<string, string>>>({});
  const [confirming, setConfirming] = useState<"primary" | "secondary" | null>(null);
  const active = subscription.state === "active";
  const keys = subscription.keys ?? UNDATED;
  const why = active ? undefined : "Keys exist only while access is active.";

  async function rotate(which: "primary" | "secondary") {
    const ok = await action.run(async () => {
      const rotated = await api.post<{ key: string }>(
        `/api/subscriptions/${subscription.id}/rotate`,
        { which },
      );
      setValues((prev) => ({ ...prev, [which]: rotated.key }));
    });
    setConfirming(null);
    if (ok) onChanged();
  }

  function reveal() {
    return action.run(async () => {
      const shown = await api.post<{ primaryKey: string; secondaryKey: string | null }>(
        `/api/subscriptions/${subscription.id}/reveal`,
      );
      setValues({ primary: shown.primaryKey, secondary: shown.secondaryKey ?? undefined });
    });
  }

  return (
    <>
      <Notice kind="error">{action.error}</Notice>
      {Object.keys(values).length > 0 && (
        <Notice kind="warn">
          Copy what you need now. Keys are encrypted at rest, every reveal is recorded against your
          name, and closing this screen puts them away.
        </Notice>
      )}
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>Age</th>
            <th>Stops working</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => {
            const absent = key.status === "absent";
            const value = values[key.which];
            return (
              <tr key={key.which}>
                <td>
                  {key.which}
                  {value && <div className="pre">{value}</div>}
                </td>
                <td>
                  {absent ? (
                    <span className="muted">not issued</span>
                  ) : (
                    <StatusChip chip={subscriptionKeyChip(key)} />
                  )}
                </td>
                <td>
                  {absent || !key.expiresAt ? (
                    <span className="muted">—</span>
                  ) : (
                    <span className="mono">
                      {(key.status === "expired" ? key.expiredAt : key.expiresAt)?.slice(0, 10)}
                    </span>
                  )}
                </td>
                <td className="right">
                  {/* Rotation is not reversible and it is not local: the old key stops working for
                      every caller holding it, at once. This is also the panel people open to *read*
                      a key, so a single unguarded click beside the value they came for is the wrong
                      shape. It asks first — not a typed confirmation, because nothing is being
                      deleted, but not one click either. Minting an absent slot breaks nothing, so
                      that one does not ask. */}
                  {confirming === key.which ? (
                    <span className="inline">
                      <span className="muted small">
                        Every caller holding the current {key.which} key stops working at the next
                        gateway poll.
                      </span>
                      <button
                        className="ghost small"
                        disabled={action.busy}
                        onClick={() => setConfirming(null)}
                      >
                        Keep it
                      </button>
                      <button
                        className="danger small"
                        disabled={action.busy}
                        onClick={() => void rotate(key.which)}
                      >
                        Rotate it
                      </button>
                    </span>
                  ) : (
                    <span className="inline">
                      {!absent && !value && (
                        <button
                          className="ghost small"
                          disabled={!active || action.busy}
                          title={why}
                          onClick={() => void reveal()}
                        >
                          Reveal
                        </button>
                      )}
                      <button
                        className="ghost small"
                        disabled={!active || action.busy}
                        title={why}
                        onClick={() => (absent ? void rotate(key.which) : setConfirming(key.which))}
                      >
                        {absent ? "Issue it" : "Rotate it"}
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted small">
        Rotate the key your callers are <em>not</em> using, move them onto it, then rotate the other.
        Doing it the other way round is an outage.
      </p>
    </>
  );
}
