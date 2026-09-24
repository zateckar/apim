/-!
# The operation spine

Every publish, configure and promote is an `operation` row (`operations.ts`), and `runOperations`
is the only thing that advances one. What it promises — and what this file proves — is that the
spine is a queue per `(resource, environment)`: an operation's snapshot is written only once every
earlier operation for the same API in the same stage has settled, so an older snapshot can never be
applied over a newer one, and a promotion is never applied before the operation it was captured
from has completed.

The model is the whole table, indexed by `rowid` (the order `runOperations` and the `earlier` guard
both use). Its steps are the four writers:

* `enqueue` — `queue()`, called by publish / configure / promote. A promotion records the source
  stage's latest operation as `sourceOperationId`, which was read *before* the insert, so it is
  always an earlier row.
* `apply` — the success path of the apply transaction: `state = 'waiting-for-gateways'`.
* `fail` — the `catch`: `retrying`, or `blocked` from the fifth attempt. Both are picked up again
  (`state IN ('queued','retrying','blocked')`), so `blocked` is a slower `retrying`, not an end.
* `converge` — the second loop: once `fleetApplied(environment)`, every `waiting-for-gateways` row
  there becomes `complete`. `fleetApplied` reads the live fleet, so the model lets the environment
  pick *any* set of waiting rows to complete at any time. That admits more behaviours than the code
  has, which is the safe direction for proving that nothing bad happens.

`apply` and `fail` both require what the transaction checks before it can get far enough to do
either: no earlier row with the same key that is neither `complete` nor `superseded`
(`operations.ts`, the `earlier` query) and, for a promotion, a `complete` parent. When either check
fails the transaction returns without writing, which is a stutter and needs no step.

Legacy promotions with a `sourceEnvironment` but no `sourceOperationId` are gated on
`fleetApplied(sourceEnvironment)` instead, an oracle about the fleet rather than about a row; they
are outside this model and the parent theorem says nothing about them.
-/

namespace Operation

inductive State where
  | queued | retrying | blocked | waiting | complete | superseded
  deriving DecidableEq, Repr

/-- `state IN ('queued','retrying','blocked')`: what `runOperations` picks up. -/
def State.pending : State → Bool
  | .queued | .retrying | .blocked => true
  | _ => false

/-- `state IN ('complete','superseded')`: what the `earlier` guard lets past. -/
def State.settled : State → Bool
  | .complete | .superseded => true
  | _ => false

/-- The snapshot has been written: `waiting-for-gateways` or `complete`. -/
def State.applied : State → Bool
  | .waiting | .complete => true
  | _ => false

/-- `attempts >= 5 ? "blocked" : "retrying"`. -/
def maxAttempts : Nat := 5

structure Op where
  /-- `(resource_id, environment)`, as one opaque key. -/
  key : Nat
  /-- `snapshot.sourceOperationId`. -/
  parent : Option Nat
  state : State
  attempts : Nat

instance : Inhabited Op := ⟨⟨0, none, .queued, 0⟩⟩

structure Sys where
  /-- Rows `0 … n-1` exist. -/
  n : Nat
  op : Nat → Op

def Sys.init : Sys := ⟨0, fun _ => default⟩

def Sys.update (s : Sys) (i : Nat) (f : Op → Op) : Sys :=
  { s with op := fun k => if k = i then f (s.op k) else s.op k }

/-- What the apply transaction checks before it writes anything. -/
def ready (s : Sys) (i : Nat) : Prop :=
  i < s.n ∧ (s.op i).state.pending = true ∧
  (∀ j, j < i → (s.op j).key = (s.op i).key → (s.op j).state.settled = true) ∧
  (∀ p, (s.op i).parent = some p → (s.op p).state = .complete)

def failed (o : Op) : Op :=
  { o with state := if o.attempts + 1 ≥ maxAttempts then .blocked else .retrying,
           attempts := o.attempts + 1 }

/-- One row under the convergence loop: `waiting-for-gateways → complete` if selected. -/
def completeIf (selected : Bool) (o : Op) : Op :=
  if o.state = .waiting ∧ selected then { o with state := .complete } else o

@[simp] theorem completeIf_key (b : Bool) (o : Op) : (completeIf b o).key = o.key := by
  unfold completeIf; split <;> rfl

@[simp] theorem completeIf_parent (b : Bool) (o : Op) : (completeIf b o).parent = o.parent := by
  unfold completeIf; split <;> rfl

theorem completeIf_applied (b : Bool) (o : Op) :
    (completeIf b o).state.applied = o.state.applied := by
  unfold completeIf; split
  · next h => simp [h.1, State.applied]
  · rfl

theorem completeIf_settled (b : Bool) (o : Op) (h : o.state.settled = true) :
    (completeIf b o).state.settled = true := by
  unfold completeIf; split
  · next h' => rw [h'.1] at h; simp [State.settled] at h
  · exact h

theorem completeIf_complete (b : Bool) (o : Op) (h : o.state = .complete) :
    (completeIf b o).state = .complete := by
  unfold completeIf; split
  · rfl
  · exact h

inductive Step : Sys → Sys → Prop
  | enqueue (s : Sys) (key : Nat) (parent : Option Nat)
      (hp : ∀ p, parent = some p → p < s.n) :
      Step s ⟨s.n + 1, fun k => if k = s.n then ⟨key, parent, .queued, 0⟩ else s.op k⟩
  | apply (s : Sys) (i : Nat) (h : ready s i) :
      Step s (s.update i fun o => { o with state := .waiting })
  | fail (s : Sys) (i : Nat) (h : ready s i) :
      Step s (s.update i failed)
  | converge (s : Sys) (sel : Nat → Bool) :
      Step s { s with op := fun k => completeIf (sel k) (s.op k) }

inductive Reachable : Sys → Prop
  | init : Reachable Sys.init
  | step {s t : Sys} : Reachable s → Step s t → Reachable t

/-! ## The invariant -/

structure Inv (s : Sys) : Prop where
  /-- Per key, applied in `rowid` order: nothing is applied while an earlier row is unsettled. -/
  ordered : ∀ i j, j < i → i < s.n → (s.op j).key = (s.op i).key →
    (s.op i).state.applied = true → (s.op j).state.settled = true
  /-- A promotion is applied only after its source operation completed. -/
  parent : ∀ i p, i < s.n → (s.op i).parent = some p →
    (s.op i).state.applied = true → (s.op p).state = .complete
  /-- A parent is an earlier row. -/
  parentEarlier : ∀ i p, i < s.n → (s.op i).parent = some p → p < i

theorem inv_init : Inv Sys.init :=
  ⟨fun _ _ _ h => absurd h (Nat.not_lt_zero _),
   fun _ _ h => absurd h (Nat.not_lt_zero _),
   fun _ _ h => absurd h (Nat.not_lt_zero _)⟩

/-- Pending is neither settled nor applied, and complete is both settled and applied. -/
theorem pending_not_settled {st : State} (h : st.pending = true) : st.settled = false := by
  cases st <;> simp_all [State.pending, State.settled]

theorem pending_not_applied {st : State} (h : st.pending = true) : st.applied = false := by
  cases st <;> simp_all [State.pending, State.applied]

theorem failed_not_applied (o : Op) : (failed o).state.applied = false := by
  unfold failed; split <;> rfl

theorem inv_step {s t : Sys} (hs : Inv s) (st : Step s t) : Inv t := by
  cases st with
  | enqueue key parent hp =>
    constructor
    · intro i j hji hi hk ha
      simp only at hi hk ha ⊢
      have hjn : j ≠ s.n := by omega
      by_cases hin : i = s.n
      · subst hin; simp [State.applied] at ha
      · simp only [hin, hjn] at hk ha ⊢
        exact hs.ordered i j hji (by omega) hk ha
    · intro i p hi hp' ha
      simp only at hi hp' ha ⊢
      by_cases hin : i = s.n
      · subst hin; simp [State.applied] at ha
      · simp only [hin] at hp' ha
        have := hs.parentEarlier i p (by omega) hp'
        have hpn : p ≠ s.n := by omega
        simp only [hpn]
        exact hs.parent i p (by omega) hp' ha
    · intro i p hi hp'
      simp only at hi hp'
      by_cases hin : i = s.n
      · subst hin; simp at hp'; subst hp'; exact hp p rfl
      · simp only [hin] at hp'
        exact hs.parentEarlier i p (by omega) hp'
  | apply i h =>
    obtain ⟨hin, hpend, hearlier, hpar⟩ := h
    constructor
    · intro a b hba ha hk happ
      simp only [Sys.update] at ha hk happ ⊢
      by_cases hai : a = i
      · subst hai
        have hbi : b ≠ a := by omega
        simp only [hbi] at hk ⊢
        exact hearlier b hba hk
      · by_cases hbi : b = i
        · -- `i` is the earlier row: it was pending, so no later row with its key was applied.
          subst hbi
          simp only [hai] at hk happ
          have := hs.ordered a b hba ha hk happ
          rw [pending_not_settled hpend] at this; contradiction
        · simp only [hai, hbi] at hk happ ⊢
          exact hs.ordered a b hba ha hk happ
    · intro a p ha hp happ
      simp only [Sys.update] at ha hp happ ⊢
      by_cases hai : a = i
      · subst hai
        simp only [ite_true] at hp
        have hpa : p ≠ a := by have := hs.parentEarlier a p ha hp; omega
        simp only [hpa]
        exact hpar p hp
      · simp only [hai] at hp happ
        have := hs.parent a p ha hp happ
        by_cases hpi : p = i
        · subst hpi; rw [this] at hpend; simp [State.pending] at hpend
        · simp only [hpi]; exact this
    · intro a p ha hp
      simp only [Sys.update] at ha hp
      by_cases hai : a = i
      · subst hai; simp only [ite_true] at hp; exact hs.parentEarlier a p ha hp
      · simp only [hai] at hp; exact hs.parentEarlier a p ha hp
  | fail i h =>
    obtain ⟨hin, hpend, _, _⟩ := h
    constructor
    · intro a b hba ha hk happ
      simp only [Sys.update] at ha hk happ ⊢
      by_cases hai : a = i
      · subst hai; simp [failed_not_applied] at happ
      · by_cases hbi : b = i
        · subst hbi
          simp only [hai] at hk happ
          have := hs.ordered a b hba ha (by simpa [failed] using hk) happ
          rw [pending_not_settled hpend] at this; contradiction
        · simp only [hai, hbi] at hk happ ⊢
          exact hs.ordered a b hba ha hk happ
    · intro a p ha hp happ
      simp only [Sys.update] at ha hp happ ⊢
      by_cases hai : a = i
      · subst hai; simp [failed_not_applied] at happ
      · simp only [hai] at hp happ
        have := hs.parent a p ha hp happ
        by_cases hpi : p = i
        · subst hpi; rw [this] at hpend; simp [State.pending] at hpend
        · simp only [hpi]; exact this
    · intro a p ha hp
      simp only [Sys.update] at ha hp
      by_cases hai : a = i
      · subst hai; simp only [failed] at hp; exact hs.parentEarlier a p ha hp
      · simp only [hai] at hp; exact hs.parentEarlier a p ha hp
  | converge sel =>
    constructor
    · intro a b hba ha hk happ
      simp only [completeIf_key] at ha hk
      simp only [completeIf_applied] at happ
      exact completeIf_settled _ _ (hs.ordered a b hba ha hk happ)
    · intro a p ha hp happ
      simp only [completeIf_parent] at ha hp
      simp only [completeIf_applied] at happ
      exact completeIf_complete _ _ (hs.parent a p ha hp happ)
    · intro a p ha hp
      simp only [completeIf_parent] at ha hp
      exact hs.parentEarlier a p ha hp

theorem reachable_inv {s : Sys} (h : Reachable s) : Inv s := by
  induction h with
  | init => exact inv_init
  | step _ st ih => exact inv_step ih st

/-! ## What the invariant buys -/

/-- An older snapshot is never applied over a newer one: per key, applied rows are applied in
`rowid` order, so at most one is still rolling out at a time. -/
theorem at_most_one_rolling_out {s : Sys} (h : Reachable s) (i j : Nat)
    (hi : i < s.n) (hj : j < s.n) (hne : i ≠ j) (hk : (s.op i).key = (s.op j).key)
    (hwi : (s.op i).state = .waiting) (hwj : (s.op j).state = .waiting) : False := by
  have inv := reachable_inv h
  rcases Nat.lt_or_gt_of_ne hne with hlt | hlt
  · have := inv.ordered j i hlt hj hk (by simp [hwj, State.applied])
    simp [hwi, State.settled] at this
  · have := inv.ordered i j hlt hi hk.symm (by simp [hwi, State.applied])
    simp [hwj, State.settled] at this

theorem applied_in_order {s : Sys} (h : Reachable s) (i j : Nat) (hji : j < i) (hi : i < s.n)
    (hk : (s.op j).key = (s.op i).key) (ha : (s.op i).state.applied = true) :
    (s.op j).state.settled = true :=
  (reachable_inv h).ordered i j hji hi hk ha

/-- A promotion never overtakes the operation it was captured from. -/
theorem promotion_after_source {s : Sys} (h : Reachable s) (i p : Nat) (hi : i < s.n)
    (hp : (s.op i).parent = some p) (ha : (s.op i).state.applied = true) :
    (s.op p).state = .complete :=
  (reachable_inv h).parent i p hi hp ha

/-- `complete` is never left, and rows are never removed. -/
theorem complete_stays {s t : Sys} (st : Step s t) (i : Nat) (hi : i < s.n)
    (hc : (s.op i).state = .complete) : i < t.n ∧ (t.op i).state = .complete := by
  cases st with
  | enqueue =>
    refine ⟨by simp; omega, ?_⟩
    have : i ≠ s.n := by omega
    simp [this, hc]
  | apply j h =>
    refine ⟨hi, ?_⟩
    simp only [Sys.update]
    by_cases hij : i = j
    · subst hij; have := h.2.1; rw [hc] at this; simp [State.pending] at this
    · simp [hij, hc]
  | fail j h =>
    refine ⟨hi, ?_⟩
    simp only [Sys.update]
    by_cases hij : i = j
    · subst hij; have := h.2.1; rw [hc] at this; simp [State.pending] at this
    · simp [hij, hc]
  | converge sel => exact ⟨hi, completeIf_complete _ _ hc⟩

/-- `blocked` is not an end: a blocked row whose guards hold is applied like any other. -/
theorem blocked_is_retried (s : Sys) (i : Nat) (h : ready s i) (_hb : (s.op i).state = .blocked) :
    ∃ t, Step s t ∧ (t.op i).state = .waiting :=
  ⟨_, .apply s i h, by simp [Sys.update]⟩

end Operation
