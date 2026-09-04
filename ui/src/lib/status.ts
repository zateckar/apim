import { LIFECYCLES, RELEASE_STATES, type Lifecycle, type ReleaseState } from "../../../shared/types.ts";

/**
 * One status vocabulary (plan §9.4).
 *
 * Every chip in the portal comes from here. The rule that makes it worth a module: **a state is
 * named by what it means for the reader**, not by the column value. "converged" is a word from the
 * reconciler; a person reading a list wants "Live". The column value stays available as the chip's
 * title, so nobody debugging is left guessing what it maps to.
 *
 * `tone` is a small closed set because colour has to mean one thing across the whole product:
 * `live` is good and current, `wait` is in progress, `stop` is broken or refusing, `past` is
 * history, `warn` is fine today and not tomorrow.
 */

export type Tone = "live" | "wait" | "stop" | "past" | "warn" | "neutral";

export interface Chip {
  label: string;
  tone: Tone;
  /** The long form: the underlying state, and what it means. Rendered as the chip's tooltip. */
  title: string;
}

export function releaseChip(state: ReleaseState): Chip {
  switch (state) {
    case "converged":
      return { label: "Live", tone: "live", title: "converged — every gateway in this environment is serving this revision" };
    case "pending":
      return { label: "Publishing", tone: "wait", title: "pending — accepted, waiting for the reconciler to apply it" };
    case "converging":
      return { label: "Publishing", tone: "wait", title: "converging — applied here, waiting for the gateways to pick it up" };
    case "superseded":
      return { label: "Replaced", tone: "past", title: "superseded — a later revision took its place, and this one can be rolled back to" };
    case "withdrawn":
      return { label: "Withdrawn", tone: "past", title: "withdrawn — it was live here and was taken out of service" };
    case "failed":
      return { label: "Failed", tone: "stop", title: "failed — publishing did not complete, and nothing changed" };
    case "stale":
      return { label: "Needs confirming", tone: "stop", title: "stale — the plan changed between confirmation and apply, so nothing was published" };
  }
}

export function lifecycleChip(lifecycle: Lifecycle): Chip | null {
  switch (lifecycle) {
    case "active":
      // No chip: "active" is the absence of news, and a chip on every row means nothing.
      return null;
    case "deprecated":
      return { label: "Deprecated", tone: "warn", title: "still served, but a newer version exists and this one will stop" };
    case "retired":
      return { label: "Retired", tone: "stop", title: "no longer served — calls to it fail" };
  }
}

/** Where a revision stands in one environment, as the revision list reports it. */
export function releasedInChip(state: "live" | "previously" | "never"): Chip {
  switch (state) {
    case "live":
      return { label: "Live", tone: "live", title: "this revision is the one being served here" };
    case "previously":
      return { label: "Was live", tone: "past", title: "this revision was live here, so it is a rollback target" };
    case "never":
      return { label: "Never", tone: "neutral", title: "this revision has never been released here" };
  }
}

export function subscriptionChip(state: string): Chip {
  return state === "active"
    ? { label: "Active", tone: "live", title: "its keys work" }
    : { label: "Revoked", tone: "stop", title: "revoked — its keys no longer work, and it cannot be un-revoked" };
}

export function instanceChip(instance: { revoked: boolean; stale: boolean; inSync?: boolean }): Chip {
  if (instance.revoked) {
    return { label: "Revoked", tone: "stop", title: "this instance's token was revoked; it stops at its next poll" };
  }
  if (instance.stale) {
    return { label: "Not reporting", tone: "stop", title: "no poll recently — it is stopped, or it cannot reach the portal" };
  }
  if (instance.inSync === false) {
    return { label: "Catching up", tone: "wait", title: "reporting, but not yet on the current configuration" };
  }
  return { label: "Healthy", tone: "live", title: "reporting, and on the current configuration" };
}

/** Everything a test iterates to assert the vocabulary is total. */
export const STATUS_DOMAINS = {
  release: RELEASE_STATES,
  lifecycle: LIFECYCLES,
  releasedIn: ["live", "previously", "never"] as const,
  subscription: ["active", "revoked"] as const,
};
