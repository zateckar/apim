/-!
# Subscription lifecycle

The states a `subscription` row moves through, and every statement in the control plane that moves
it. `kafka_access` runs the same machine — `kafka.ts` `DELETE /api/kafka/access/:id` and the
`kafka.request` branch of the approval handler are the same transitions word for word — so one
model covers both.

Writers, each one constructor of `step`:

* creation — `api/catalog.ts` (`own ? "activating" : "pending"`): an application subscribing to its
  own product skips approval.
* decision — `integrations.ts` approval handler: only a `pending` row is decided; anything else is
  a 409 and the row is untouched.
* convergence — `operations.ts` `runOperations`, once `fleetApplied` holds for the environment:
  `activating → active`, `revoking → revoked`.
* withdrawal — `api/catalog.ts` `DELETE /api/subscriptions/:id`: `pending → cancelled`, the three
  terminal states stay put, everything else goes to `revoking`.

"Served" is `config-build.ts`: a key reaches the gateways' document when the row is `active` *or*
`activating`, which is how activation converges at all — the gateway has to hold the key before the
fleet can be seen to have applied it.
-/

namespace Subscription

inductive State where
  | pending | activating | active | revoking | revoked | rejected | cancelled
  deriving DecidableEq, Repr

inductive Event where
  | approve | reject | converge | withdraw
  deriving DecidableEq, Repr

def created (own : Bool) : State := if own then .activating else .pending

def step : State → Event → State
  | .pending,    .approve  => .activating
  | .pending,    .reject   => .rejected
  | .activating, .converge => .active
  | .revoking,   .converge => .revoked
  | .pending,    .withdraw => .cancelled
  | .cancelled,  .withdraw => .cancelled
  | .rejected,   .withdraw => .rejected
  | .revoked,    .withdraw => .revoked
  | _,           .withdraw => .revoking
  | s,           _         => s

def run (s : State) (es : List Event) : State := es.foldl step s

/-- `config-build.ts`: `s.state IN ('active','activating')`. -/
def served : State → Bool
  | .activating | .active => true
  | _ => false

def terminal : State → Bool
  | .revoked | .rejected | .cancelled => true
  | _ => false

/-! ## Terminal states are terminal -/

theorem step_terminal (s : State) (e : Event) (h : terminal s = true) : step s e = s := by
  cases s <;> cases e <;> simp_all [terminal, step]

theorem run_terminal (s : State) (es : List Event) (h : terminal s = true) : run s es = s := by
  induction es with
  | nil => rfl
  | cons e es ih => simp [run, List.foldl, step_terminal s e h] at ih ⊢; exact ih

/-- A revoked key never comes back, whatever happens after. -/
theorem revoked_forever (es : List Event) : served (run .revoked es) = false := by
  rw [run_terminal _ _ rfl]; rfl

/-! ## Nobody is served without somebody's approval

The only edge into a served state from `pending` is `approve`. So a subscription to somebody else's
product that is never approved never reaches the gateways, however the other events interleave —
and, since the statement is over every list, over every prefix of every list too.
-/

def unapproved : State → Bool
  | .pending | .rejected | .cancelled => true
  | _ => false

theorem step_unapproved (s : State) (e : Event) (hs : unapproved s = true) (he : e ≠ .approve) :
    unapproved (step s e) = true := by
  cases s <;> cases e <;> simp_all [unapproved, step]

theorem run_unapproved (s : State) (es : List Event) (hs : unapproved s = true)
    (he : Event.approve ∉ es) : unapproved (run s es) = true := by
  induction es generalizing s with
  | nil => exact hs
  | cons e es ih =>
    simp only [List.mem_cons, not_or] at he
    exact ih (step s e) (step_unapproved s e hs (Ne.symm he.1)) he.2

theorem never_served_without_approval (es : List Event) (he : Event.approve ∉ es) :
    served (run (created false) es) = false := by
  show served (run .pending es) = false
  have := run_unapproved .pending es rfl he
  revert this; generalize run .pending es = t; cases t <;> simp [unapproved, served]

/-! ## Withdrawal fails closed at the next convergence

After a withdrawal the row is served for at most as long as it takes the fleet to converge once:
from then on it is in a terminal state, so it stays unserved forever. This is the property that
`fleetApplied`'s "abandoned replica" rule exists to keep live — a convergence that can never happen
would leave a withdrawn key served indefinitely.
-/

def withdrawn : State → Bool
  | .revoking | .revoked | .rejected | .cancelled => true
  | _ => false

theorem step_withdraw_withdrawn (s : State) : withdrawn (step s .withdraw) = true := by
  cases s <;> rfl

theorem step_withdrawn (s : State) (e : Event) (hs : withdrawn s = true) :
    withdrawn (step s e) = true := by
  cases s <;> cases e <;> simp_all [withdrawn, step]

theorem converge_after_withdraw (s : State) (hs : withdrawn s = true) :
    terminal (step s .converge) = true := by
  cases s <;> simp_all [withdrawn, terminal, step]

theorem withdrawn_stays_withdrawn (s : State) (es : List Event) :
    withdrawn (run (step s .withdraw) es) = true := by
  suffices ∀ t, withdrawn t = true → withdrawn (run t es) = true from
    this _ (step_withdraw_withdrawn s)
  induction es with
  | nil => intro t ht; exact ht
  | cons e es ih => intro t ht; exact ih _ (step_withdrawn t e ht)

theorem withdrawal_fails_closed (s : State) (es : List Event) (hc : Event.converge ∈ es) :
    served (run (step s .withdraw) es) = false := by
  suffices ∀ t, withdrawn t = true → served (run t es) = false from
    this _ (step_withdraw_withdrawn s)
  induction es with
  | nil => simp at hc
  | cons e es ih =>
    intro t ht
    simp only [List.mem_cons] at hc
    show served (run (step t e) es) = false
    rcases hc with rfl | hc
    · have := converge_after_withdraw t ht
      rw [run_terminal _ _ this]
      revert this; generalize step t .converge = u; cases u <;> simp [terminal, served]
    · exact ih hc _ (step_withdrawn t e ht)

/-! ## The only way to `active` is through `activating` and a convergence -/

theorem into_active (s : State) (e : Event) (h : step s e = .active) :
    s = .active ∨ (s = .activating ∧ e = .converge) := by
  cases s <;> cases e <;> simp_all [step]

end Subscription
