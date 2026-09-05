/**
 * "You cannot do this, and here is why" (plan §9.4).
 *
 * The rule: **an action the caller cannot perform is disabled with a reason, never hidden.** A
 * hidden button teaches nothing — the reader concludes the feature does not exist, asks a colleague,
 * and learns the model by rumour. A disabled button with one sentence beside it teaches the
 * permission model at the exact moment somebody wanted it.
 *
 * The control plane already answers "can this caller act here" per object, as `capabilities: []`
 * on the object itself (`read`, `update`, `delete`, `publish`, `policy`). This module turns that
 * array into the two things a control needs: whether it is enabled, and the sentence to show.
 */

export interface Permission {
  enabled: boolean;
  /** Null when enabled. One sentence, naming who *can* do it, so the reader knows who to ask. */
  reason: string | null;
}

export const ALLOWED: Permission = { enabled: true, reason: null };

/** The actions the UI gates. Each names the capability the control plane grants for it. */
export const ACTIONS = {
  edit: { capability: "update", verb: "change this" },
  delete: { capability: "delete", verb: "delete this" },
  publish: { capability: "publish", verb: "publish or promote this API" },
  policy: { capability: "policy", verb: "change this API's policies" },
  route: { capability: "publish", verb: "change where this API is routed" },
  binding: { capability: "publish", verb: "change which backend this API forwards to" },
  members: { capability: "update", verb: "change what is in this product" },
  keys: { capability: "update", verb: "reveal or rotate this subscription's keys" },
} as const;

export type Action = keyof typeof ACTIONS;

/**
 * `owner` is what the sentence names. Passing the application's display name rather than its id is
 * deliberate: "the Orders application" is a group somebody can go and find, `application_orders` is not.
 */
export function permit(
  action: Action,
  capabilities: string[] | undefined,
  owner?: { application?: string | null },
): Permission {
  const { capability, verb } = ACTIONS[action];
  if (capabilities?.includes(capability)) return ALLOWED;
  const application = owner?.application ? `the ${owner.application} application` : "the owning application";
  return { enabled: false, reason: `Only a member of ${application}, or an administrator, can ${verb}.` };
}

/**
 * The estate's own controls: registering a certificate authority, attaching a global policy unit,
 * minting or revoking a gateway. These are not per-object, so they are not in `capabilities[]`.
 * A non-admin who deep-links to one of these screens sees it with every control disabled and this
 * sentence — which is the plan's `[P1-26]` rule: sections follow capability, screens do not lie.
 */
export function permitAdmin(isAdmin: boolean, what: string): Permission {
  if (isAdmin) return ALLOWED;
  return {
    enabled: false,
    reason: `Only a platform administrator can ${what}. You can see the current state here.`,
  };
}

/**
 * A control that is blocked by *state* rather than by permission — a frozen revision, an API with
 * no definition yet. Same shape, so one component renders both and a screen never has two ways of
 * saying "not now".
 */
export function blockedBecause(condition: boolean, reason: string): Permission {
  return condition ? { enabled: false, reason } : ALLOWED;
}

/** The first reason that applies, so a control can be gated by permission *and* by state. */
export function first(...permissions: Permission[]): Permission {
  return permissions.find((permission) => !permission.enabled) ?? ALLOWED;
}
