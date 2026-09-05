import { Field } from "./common";
export function PolicyForm({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  let policy: any;
  try {
    policy = JSON.parse(value);
  } catch {
    return <p>Correct the advanced settings JSON to use these controls.</p>;
  }
  const change = (name: string, unit: unknown) => {
    const next = { ...policy };
    if (unit === undefined) delete next[name];
    else next[name] = unit;
    onChange(JSON.stringify(next, null, 2));
  };
  return (
    <fieldset disabled={disabled} className="native-form-grid">
      <Field label="API access">
        <select
          value={policy["auth.subscriptionKey"] ? "key" : "public"}
          onChange={(e) =>
            change(
              "auth.subscriptionKey",
              e.target.value === "key"
                ? { in: "header", name: "X-Api-Key" }
                : undefined,
            )
          }
        >
          <option value="key">Require subscription key</option>
          <option value="public">Public access</option>
        </select>
      </Field>
      <Field label="Backend timeout (milliseconds)">
        <input
          type="number"
          min={1}
          value={policy.timeoutMs ?? 30000}
          onChange={(e) => change("timeoutMs", Number(e.target.value))}
        />
      </Field>
      <Field label="Rate limit">
        <select
          value={policy.rateLimit ? "enabled" : "disabled"}
          onChange={(e) =>
            change(
              "rateLimit",
              e.target.value === "enabled"
                ? {
                    calls: 100,
                    periodSec: 60,
                    per: "instance",
                    by: "subscription",
                    scope: "route",
                  }
                : undefined,
            )
          }
        >
          <option value="disabled">No rate limit</option>
          <option value="enabled">Limit each subscription</option>
        </select>
      </Field>
      {policy.rateLimit && (
        <>
          <Field label="Calls per gateway">
            <input
              type="number"
              min={1}
              value={policy.rateLimit.calls}
              onChange={(e) =>
                change("rateLimit", {
                  ...policy.rateLimit,
                  calls: Number(e.target.value),
                })
              }
            />
          </Field>
          <Field label="Period (seconds)">
            <input
              type="number"
              min={1}
              value={policy.rateLimit.periodSec}
              onChange={(e) =>
                change("rateLimit", {
                  ...policy.rateLimit,
                  periodSec: Number(e.target.value),
                })
              }
            />
          </Field>
        </>
      )}
    </fieldset>
  );
}
