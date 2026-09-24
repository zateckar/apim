/-!
# Releases

A `release` row says which revision of an API is live in one environment. Two paths write them,
and the model has one step per statement:

* `request` — `api/promotion.ts`: a confirmed release is inserted `pending` and a reconcile job is
  queued for it.
* `reconcile` — `jobs.ts` `reconcile`, intent `apply`: every other `converged` release of the key
  becomes `superseded`, then this one becomes `converged`.
* `goStale` — the same job, when a release inserted after this one has already reached the fleet:
  this one becomes `stale` and nothing else is written.
* `fail` — `jobs.ts` `runDueJobs`, when the job throws `Unrecoverable` (it can never say which
  environment it is for): `UPDATE release SET state = 'failed' … WHERE id = ? AND state =
  'pending'`, so only a `pending` release fails.
* `withdraw` — `jobs.ts` `reconcile`, intent `remove`: `converged → withdrawn`, and every release
  of the key still `pending` becomes `stale`.
* `spine` — `operations.ts` `runOperations`: `converged → superseded`, and a new release inserted
  already `converged`.

The reconcile job may run for any release, any number of times. It retries with backoff and is
never cancelled; any other throw — a paused gateway, a lease another runner holds, no gateway at
all — writes nothing to the release and is a stutter. And the job is marked `done` in a statement
*after* the apply transaction, with a stuck `running` job re-queued a minute later, so a crash
between the two replays an apply that already committed. `reconcile` therefore has no "job not yet
done" precondition. What it has instead are the two guards at the top of the transaction: only a
`pending` release is touched (anything else is a stutter, so it needs no step), and a `pending`
one overtaken by a later release goes `stale`.

`schema-002.sql`'s trigger `release_state_history` allows `superseded` and `withdrawn` only from
`converged`; `schema.sql`'s unique index `release_live` allows one `converged` row per key. The
promotion gate (`promotion.ts` `reachedFleet`, spec `api-versioning-and-stage` "Promote only along
the chain") reads "this revision has at some point reached the fleet here" as
`state IN ('converged','superseded','withdrawn')`.

Proved: no writer trips the trigger or the unique index; "reached the fleet" is never lost; the
live release is always the newest one to have reached the fleet (spec "Never let an earlier release
overtake one that reached the fleet after it"); and no release that existed when its API was
withdrawn is ever live again (`withdrawal_wins`).

The last section is the code before those guards, kept as the regression proof: there, a retried
job for an older release converged it over a newer one (`older_release_resurrects`), a retried job
published an API again after it was withdrawn (`withdrawn_then_applied`), and a replayed job did
the same for a withdrawn release (`replay_resurrects_withdrawn`).
-/

namespace Release

inductive State where
  | pending | converging | converged | superseded | withdrawn | failed | stale
  deriving DecidableEq, Repr

/-- `REACHED_FLEET_STATES`. -/
def State.reached : State → Bool
  | .converged | .superseded | .withdrawn => true
  | _ => false

/-- `release_state_history`: `superseded`/`withdrawn` only from `converged`. -/
def triggerAllows (old new : State) : Bool :=
  match new with
  | .superseded | .withdrawn => old == .converged
  | _ => true

structure Rel where
  /-- `(resource_id, environment)`. -/
  key : Nat
  state : State

instance : Inhabited Rel := ⟨⟨0, .pending⟩⟩

/-- Rows `0 … n-1`, in `rowid` order. -/
structure Sys where
  n : Nat
  rel : Nat → Rel

def Sys.init : Sys := ⟨0, fun _ => default⟩

def Sys.push (s : Sys) (r : Rel) : Sys := ⟨s.n + 1, fun k => if k = s.n then r else s.rel k⟩

/-- `UPDATE release SET state = <to> WHERE resource_id = ? AND environment = ? AND state = 'converged'`. -/
def retire (to : State) (key : Nat) (r : Rel) : Rel :=
  if r.key = key ∧ r.state = .converged then { r with state := to } else r

@[simp] theorem retire_key (to : State) (key : Nat) (r : Rel) : (retire to key r).key = r.key := by
  unfold retire; split <;> rfl

theorem retire_reached (to : State) (hto : to.reached = true) (key : Nat) (r : Rel) :
    (retire to key r).state.reached = r.state.reached := by
  unfold retire; split
  · next h => rw [h.2]; exact hto
  · rfl

theorem retire_converged (to : State) (hto : to ≠ .converged) (key : Nat) (r : Rel)
    (h : (retire to key r).state = .converged) : r.state = .converged ∧ r.key ≠ key := by
  unfold retire at h; split at h
  · exact absurd h hto
  · next hn => exact ⟨h, fun hk => hn ⟨hk, h⟩⟩

/-- The trigger fires on rows an `UPDATE` touches, and `retire` touches only `converged` ones. -/
theorem retire_trigger (to : State) (key : Nat) (r : Rel) (hch : (retire to key r).state ≠ r.state) :
    triggerAllows r.state (retire to key r).state = true := by
  unfold retire at hch ⊢; split
  · next h => cases to <;> simp [triggerAllows, h.2]
  · next h => simp [h] at hch

theorem retire_unreached (to : State) (key : Nat) (r : Rel) (h : r.state.reached = false) :
    retire to key r = r := by
  unfold retire; split
  · next hc => rw [hc.2] at h; simp [State.reached] at h
  · rfl

/-- The reconcile apply transaction, for release `i`. -/
def reconciled (s : Sys) (i : Nat) : Sys :=
  ⟨s.n, fun k => if k = i then { s.rel i with state := .converged }
                 else retire .superseded (s.rel i).key (s.rel k)⟩

/-- `UPDATE release SET state = <to>, reason = ? WHERE id = ?`: `stale` or `failed`. -/
def settled (s : Sys) (i : Nat) (to : State) : Sys :=
  ⟨s.n, fun k => if k = i then { s.rel i with state := to } else s.rel k⟩

def retireAll (to : State) (key : Nat) (s : Sys) : Sys := ⟨s.n, fun k => retire to key (s.rel k)⟩

theorem retire_of_ne (to : State) (key : Nat) (r : Rel) (h : r.state ≠ .converged) :
    retire to key r = r := by
  unfold retire; split
  · next hc => exact absurd hc.2 h
  · rfl

/-- The `remove` job, per row: `converged → withdrawn`, `pending → stale`, for one key. -/
def withdrawRow (key : Nat) (r : Rel) : Rel :=
  if r.key = key ∧ r.state = .converged then { r with state := .withdrawn }
  else if r.key = key ∧ r.state = .pending then { r with state := .stale }
  else r

def withdrawn (key : Nat) (s : Sys) : Sys := ⟨s.n, fun k => withdrawRow key (s.rel k)⟩

@[simp] theorem withdrawRow_key (key : Nat) (r : Rel) : (withdrawRow key r).key = r.key := by
  unfold withdrawRow; split
  · rfl
  · split <;> rfl

theorem withdrawRow_reached (key : Nat) (r : Rel) :
    (withdrawRow key r).state.reached = r.state.reached := by
  unfold withdrawRow; split
  · next h => simp [h.2, State.reached]
  · split
    · next h => simp [h.2, State.reached]
    · rfl

theorem withdrawRow_converged (key : Nat) (r : Rel) (h : (withdrawRow key r).state = .converged) :
    r.state = .converged ∧ r.key ≠ key := by
  unfold withdrawRow at h; split at h
  · simp at h
  · next h1 => split at h
               · simp at h
               · exact ⟨h, fun hk => h1 ⟨hk, h⟩⟩

theorem withdrawRow_trigger (key : Nat) (r : Rel) (hch : (withdrawRow key r).state ≠ r.state) :
    triggerAllows r.state (withdrawRow key r).state = true := by
  unfold withdrawRow at hch ⊢; split
  · next h => simp [triggerAllows, h.2]
  · split
    · simp [triggerAllows]
    · next h1 h2 => simp [h1, h2] at hch

/-- Neither `pending` nor `converged`: a row no writer will ever make live again. -/
def State.dead : State → Bool
  | .pending | .converged => false
  | _ => true

theorem withdrawRow_dead (key : Nat) (r : Rel) (h : r.state.dead = true) : withdrawRow key r = r := by
  unfold withdrawRow; split
  · next hc => rw [hc.2] at h; simp [State.dead] at h
  · split
    · next hc => rw [hc.2] at h; simp [State.dead] at h
    · rfl

theorem withdrawRow_clears (key : Nat) (r : Rel) (hk : r.key = key) :
    (withdrawRow key r).state.dead = true := by
  unfold withdrawRow; split
  · rfl
  · split
    · rfl
    · next h1 h2 => cases hs : r.state <;> simp_all [State.dead]

/-- `jobs.ts`: a release inserted after `i`, of the same key, has reached the fleet. -/
def overtaken (s : Sys) (i : Nat) : Prop :=
  ∃ j, i < j ∧ j < s.n ∧ (s.rel j).key = (s.rel i).key ∧ (s.rel j).state.reached = true

inductive Step : Sys → Sys → Prop
  | request (s : Sys) (key : Nat) : Step s (s.push ⟨key, .pending⟩)
  | reconcile (s : Sys) (i : Nat) (hi : i < s.n) (hp : (s.rel i).state = .pending)
      (hnew : ¬ overtaken s i) : Step s (reconciled s i)
  | goStale (s : Sys) (i : Nat) (hi : i < s.n) (hp : (s.rel i).state = .pending)
      (hold : overtaken s i) : Step s (settled s i .stale)
  | fail (s : Sys) (i : Nat) (hi : i < s.n) (hp : (s.rel i).state = .pending) :
      Step s (settled s i .failed)
  | withdraw (s : Sys) (key : Nat) : Step s (withdrawn key s)
  | spine (s : Sys) (key : Nat) :
      Step s ((retireAll .superseded key s).push ⟨key, .converged⟩)

inductive Reachable : Sys → Prop
  | init : Reachable Sys.init
  | step {s t : Sys} : Reachable s → Step s t → Reachable t

/-- Any number of steps, from any state. -/
inductive Steps : Sys → Sys → Prop
  | refl (s : Sys) : Steps s s
  | tail {s t u : Sys} : Steps s t → Step t u → Steps s u

/-! ### Row lemmas: what each step leaves at index `k` -/

@[simp] theorem push_n (s : Sys) (r : Rel) : (s.push r).n = s.n + 1 := rfl
theorem push_new (s : Sys) (r : Rel) (k : Nat) (h : k = s.n) : (s.push r).rel k = r := by
  simp [Sys.push, h]
theorem push_old (s : Sys) (r : Rel) (k : Nat) (h : k < s.n) : (s.push r).rel k = s.rel k := by
  simp [Sys.push, Nat.ne_of_lt h]
@[simp] theorem retireAll_n (to : State) (key : Nat) (s : Sys) : (retireAll to key s).n = s.n := rfl
@[simp] theorem retireAll_rel (to : State) (key : Nat) (s : Sys) (k : Nat) :
    (retireAll to key s).rel k = retire to key (s.rel k) := rfl
@[simp] theorem reconciled_n (s : Sys) (i : Nat) : (reconciled s i).n = s.n := rfl
theorem reconciled_self (s : Sys) (i : Nat) :
    (reconciled s i).rel i = { s.rel i with state := .converged } := by
  simp [reconciled]
theorem reconciled_other (s : Sys) (i k : Nat) (h : k ≠ i) :
    (reconciled s i).rel k = retire .superseded (s.rel i).key (s.rel k) := by
  simp [reconciled, h]
@[simp] theorem withdrawn_n (key : Nat) (s : Sys) : (withdrawn key s).n = s.n := rfl
@[simp] theorem withdrawn_rel (key : Nat) (s : Sys) (k : Nat) :
    (withdrawn key s).rel k = withdrawRow key (s.rel k) := rfl
@[simp] theorem settled_n (s : Sys) (i : Nat) (to : State) : (settled s i to).n = s.n := rfl
theorem settled_self (s : Sys) (i : Nat) (to : State) :
    (settled s i to).rel i = { s.rel i with state := to } := by
  simp [settled]
theorem settled_other (s : Sys) (i k : Nat) (to : State) (h : k ≠ i) : (settled s i to).rel k = s.rel k := by
  simp [settled, h]

/-- A new index is either an old one or the one just pushed. -/
theorem push_cases {n k : Nat} (h : k < n + 1) : k < n ∨ k = n := by omega

/-! ## No writer trips the trigger

So none of these statements can abort on it, which is what makes it safe to read the trigger as a
fact about the data rather than as a guard that might be rolling transactions back.
-/

theorem step_respects_trigger {s t : Sys} (st : Step s t) (k : Nat) (hk : k < s.n)
    (hch : (t.rel k).state ≠ (s.rel k).state) :
    triggerAllows (s.rel k).state (t.rel k).state = true := by
  cases st with
  | request => rw [push_old _ _ _ hk] at hch; exact absurd rfl hch
  | reconcile i _ _ _ =>
    by_cases h : k = i
    · rw [h, reconciled_self]; cases (s.rel i).state <;> rfl
    · rw [reconciled_other _ _ _ h] at hch ⊢; exact retire_trigger _ _ _ hch
  | goStale i _ _ _ | fail i _ _ =>
    by_cases h : k = i
    · rw [h, settled_self]; cases (s.rel i).state <;> rfl
    · rw [settled_other _ _ _ _ h] at hch; exact absurd rfl hch
  | withdraw => rw [withdrawn_rel] at hch ⊢; exact withdrawRow_trigger _ _ hch
  | spine =>
    rw [push_old _ _ _ (by simpa using hk), retireAll_rel] at hch ⊢
    exact retire_trigger _ _ _ hch

/-! ## Reaching the fleet is never undone

The promotion gate's "at some point" reading depends on this: a revision that reached TEST once may
be promoted to PROD after TEST has moved on. `goStale` and `fail` are where it could break — settling a
`superseded` row would erase that it ever got there (`staled_unreaches`) — and the `pending` guard
is what prevents it (`hp`).
-/

theorem staled_unreaches (s : Sys) (i : Nat) : ((settled s i .stale).rel i).state.reached = false := by
  rw [settled_self]; rfl

theorem reached_monotone {s t : Sys} (st : Step s t) (k : Nat) (hk : k < s.n)
    (h : (s.rel k).state.reached = true) : k < t.n ∧ (t.rel k).state.reached = true := by
  cases st with
  | request => exact ⟨by simp; omega, by rw [push_old _ _ _ hk]; exact h⟩
  | reconcile i _ _ _ =>
    refine ⟨hk, ?_⟩
    by_cases hki : k = i
    · rw [hki, reconciled_self]; rfl
    · rw [reconciled_other _ _ _ hki, retire_reached _ rfl]; exact h
  | goStale i _ hp _ | fail i _ hp =>
    refine ⟨hk, ?_⟩
    by_cases hki : k = i
    · rw [hki, hp] at h; simp [State.reached] at h
    · rw [settled_other _ _ _ _ hki]; exact h
  | withdraw => exact ⟨hk, by rw [withdrawn_rel, withdrawRow_reached]; exact h⟩
  | spine =>
    refine ⟨by simp; omega, ?_⟩
    rw [push_old _ _ _ (by simpa using hk), retireAll_rel, retire_reached _ rfl]; exact h

/-! ## At most one live release per key

Which is also `release_live`, so no writer is ever refused by that index either.
-/

def OneLive (s : Sys) : Prop :=
  ∀ i j, i < s.n → j < s.n → i ≠ j → (s.rel i).key = (s.rel j).key →
    (s.rel i).state = .converged → (s.rel j).state = .converged → False

theorem oneLive_retire (to : State) (hto : to ≠ .converged) (key : Nat) {s : Sys} (hs : OneLive s) :
    OneLive (retireAll to key s) := by
  intro i j hi hj hne hk hci hcj
  simp only [retireAll_n, retireAll_rel, retire_key] at hi hj hk hci hcj
  exact hs i j hi hj hne hk (retire_converged _ hto _ _ hci).1 (retire_converged _ hto _ _ hcj).1

theorem oneLive_push {s : Sys} (hs : OneLive s) (r : Rel)
    (hfree : r.state = .converged → ∀ k, k < s.n → (s.rel k).key = r.key → (s.rel k).state ≠ .converged) :
    OneLive (s.push r) := by
  intro i j hi hj hne hk hci hcj
  simp only [push_n] at hi hj
  rcases push_cases hi with hi' | hi' <;> rcases push_cases hj with hj' | hj'
  · rw [push_old _ _ _ hi'] at hk hci; rw [push_old _ _ _ hj'] at hk hcj
    exact hs i j hi' hj' hne hk hci hcj
  · rw [push_old _ _ _ hi'] at hk hci; rw [push_new _ _ _ hj'] at hk hcj
    exact hfree hcj i hi' hk hci
  · rw [push_new _ _ _ hi'] at hk hci; rw [push_old _ _ _ hj'] at hk hcj
    exact hfree hci j hj' hk.symm hcj
  · exact hne (hi'.trans hj'.symm)

theorem oneLive_reconciled {s : Sys} (hs : OneLive s) (r : Nat) : OneLive (reconciled s r) := by
  intro i j hi hj hne hk hci hcj
  simp only [reconciled_n] at hi hj
  by_cases hir : i = r
  · have hjr : j ≠ r := fun h => hne (hir.trans h.symm)
    rw [hir] at hk; simp only [reconciled_self] at hk
    simp only [reconciled_other _ _ _ hjr, retire_key] at hk hcj
    exact (retire_converged _ (by decide) _ _ hcj).2 hk.symm
  · by_cases hjr : j = r
    · rw [hjr] at hk; simp only [reconciled_self] at hk
      simp only [reconciled_other _ _ _ hir, retire_key] at hk hci
      exact (retire_converged _ (by decide) _ _ hci).2 hk
    · simp only [reconciled_other _ _ _ hir, retire_key] at hk hci
      simp only [reconciled_other _ _ _ hjr, retire_key] at hk hcj
      exact hs i j hi hj hne hk (retire_converged _ (by decide) _ _ hci).1
        (retire_converged _ (by decide) _ _ hcj).1

theorem oneLive_step {s t : Sys} (hs : OneLive s) (st : Step s t) : OneLive t := by
  cases st with
  | request key => exact oneLive_push hs _ (fun h => by simp at h)
  | reconcile r _ _ _ => exact oneLive_reconciled hs r
  | goStale r _ _ _ | fail r _ _ =>
    intro i j hi hj hne hk hci hcj
    simp only [settled_n] at hi hj
    by_cases hir : i = r
    · rw [hir, settled_self] at hci; simp at hci
    · by_cases hjr : j = r
      · rw [hjr, settled_self] at hcj; simp at hcj
      · rw [settled_other _ _ _ _ hir] at hk hci; rw [settled_other _ _ _ _ hjr] at hk hcj
        exact hs i j hi hj hne hk hci hcj
  | withdraw key =>
    intro i j hi hj hne hk hci hcj
    simp only [withdrawn_n, withdrawn_rel, withdrawRow_key] at hi hj hk hci hcj
    exact hs i j hi hj hne hk (withdrawRow_converged _ _ hci).1 (withdrawRow_converged _ _ hcj).1
  | spine key =>
    refine oneLive_push (oneLive_retire _ (by decide) key hs) _ (fun _ k _ hk hc => ?_)
    simp only [retireAll_rel, retire_key] at hk hc
    exact (retire_converged _ (by decide) _ _ hc).2 hk

theorem reachable_oneLive {s : Sys} (h : Reachable s) : OneLive s := by
  induction h with
  | init => intro i _ hi; exact absurd hi (Nat.not_lt_zero _)
  | step _ st ih => exact oneLive_step ih st

/-! ## The live release is the newest one to have reached the fleet

A deliberate rollback is not in tension with this: it is a *new* release of the older revision, so
nothing newer than it has reached the fleet.
-/

/-- Among releases of one key, a live one is never older than one that has reached the fleet. -/
def NewestWins (s : Sys) : Prop :=
  ∀ i j, i < j → j < s.n → (s.rel i).key = (s.rel j).key →
    (s.rel i).state = .converged → (s.rel j).state.reached = false

theorem newestWins_retire (to : State) (hto : to ≠ .converged) (key : Nat) {s : Sys}
    (hs : NewestWins s) : NewestWins (retireAll to key s) := by
  intro i j hij hj hk hci
  simp only [retireAll_n, retireAll_rel, retire_key] at hj hk hci ⊢
  have := hs i j hij hj hk (retire_converged _ hto _ _ hci).1
  rw [retire_unreached _ _ _ this]; exact this

theorem newestWins_step {s t : Sys} (hs : NewestWins s) (st : Step s t) : NewestWins t := by
  cases st with
  | request key =>
    intro i j hij hj hk hci
    simp only [push_n] at hj
    have hi : i < s.n := by omega
    rw [push_old _ _ _ hi] at hk hci
    rcases push_cases hj with hj' | hj'
    · rw [push_old _ _ _ hj'] at hk ⊢; exact hs i j hij hj' hk hci
    · rw [push_new _ _ _ hj']; rfl
  | reconcile r _ _ hnew =>
    intro i j hij hj hk hci
    simp only [reconciled_n] at hj
    by_cases hir : i = r
    · have hjr : j ≠ r := by omega
      rw [hir] at hk; simp only [reconciled_self] at hk
      simp only [reconciled_other _ _ _ hjr, retire_key] at hk ⊢
      have hnr : (s.rel j).state.reached = false := by
        cases hre : (s.rel j).state.reached
        · rfl
        · exact absurd ⟨j, hir ▸ hij, hj, hk.symm, hre⟩ hnew
      rw [retire_unreached _ _ _ hnr]; exact hnr
    · simp only [reconciled_other _ _ _ hir, retire_key] at hk hci
      obtain ⟨hci', hki⟩ := retire_converged _ (by decide) _ _ hci
      by_cases hjr : j = r
      · rw [hjr] at hk; simp only [reconciled_self] at hk; exact absurd hk hki
      · simp only [reconciled_other _ _ _ hjr, retire_key] at hk ⊢
        have := hs i j hij hj hk hci'
        rw [retire_unreached _ _ _ this]; exact this
  | goStale r _ _ _ | fail r _ _ =>
    intro i j hij hj hk hci
    simp only [settled_n] at hj
    by_cases hir : i = r
    · rw [hir, settled_self] at hci; simp at hci
    · rw [settled_other _ _ _ _ hir] at hk hci
      by_cases hjr : j = r
      · rw [hjr, settled_self]; rfl
      · rw [settled_other _ _ _ _ hjr] at hk ⊢
        exact hs i j hij hj hk hci
  | withdraw key =>
    intro i j hij hj hk hci
    simp only [withdrawn_n, withdrawn_rel, withdrawRow_key] at hj hk hci ⊢
    rw [withdrawRow_reached]; exact hs i j hij hj hk (withdrawRow_converged _ _ hci).1
  | spine key =>
    have hr := newestWins_retire .superseded (by decide) key hs
    intro i j hij hj hk hci
    simp only [push_n, retireAll_n] at hj
    have hi : i < s.n := by omega
    rw [push_old _ _ _ (by simpa using hi)] at hk hci
    rcases push_cases hj with hj' | hj'
    · rw [push_old _ _ _ (by simpa using hj')] at hk ⊢
      exact hr i j hij (by simpa using hj') hk hci
    · rw [push_new (retireAll .superseded key s) _ _ hj'] at hk
      simp only [retireAll_rel, retire_key] at hk hci
      exact absurd hk (retire_converged .superseded (by decide) _ _ hci).2

theorem reachable_newestWins {s : Sys} (h : Reachable s) : NewestWins s := by
  induction h with
  | init => intro _ j _ hj; exact absurd hj (Nat.not_lt_zero _)
  | step _ st ih => exact newestWins_step ih st

/-! ## A withdrawal wins over every release that existed when it ran

Spec `api-versioning-and-stage`, "A withdrawal overtakes a release still waiting to apply". The
withdrawal leaves every row of its key `dead` — neither `pending` nor `converged` — and no writer
ever turns a `dead` row live again: `reconcile` and `goStale` need `pending`, and every other writer
only moves `converged` rows or inserts new ones.
-/

theorem dead_step {s t : Sys} (st : Step s t) (k : Nat) (hk : k < s.n)
    (h : (s.rel k).state.dead = true) : k < t.n ∧ (t.rel k).state.dead = true := by
  have hnc : (s.rel k).state ≠ .converged := fun e => by rw [e] at h; simp [State.dead] at h
  have hnp : ∀ i, (s.rel i).state = .pending → k ≠ i := fun i hp e => by
    rw [e, hp] at h; simp [State.dead] at h
  cases st with
  | request => exact ⟨by simp; omega, by rw [push_old _ _ _ hk]; exact h⟩
  | reconcile i _ hp _ =>
    refine ⟨hk, ?_⟩
    rw [reconciled_other _ _ _ (hnp i hp), retire_of_ne _ _ _ hnc]; exact h
  | goStale i _ hp _ | fail i _ hp => exact ⟨hk, by rw [settled_other _ _ _ _ (hnp i hp)]; exact h⟩
  | withdraw => exact ⟨hk, by rw [withdrawn_rel, withdrawRow_dead _ _ h]; exact h⟩
  | spine =>
    refine ⟨by simp; omega, ?_⟩
    rw [push_old _ _ _ (by simpa using hk), retireAll_rel, retire_of_ne _ _ _ hnc]; exact h

theorem withdrawal_wins {s u : Sys} (key k : Nat) (hk : k < s.n) (hkey : (s.rel k).key = key)
    (h : Steps (withdrawn key s) u) : k < u.n ∧ (u.rel k).state ≠ .converged := by
  suffices k < u.n ∧ (u.rel k).state.dead = true from
    ⟨this.1, fun e => by have := this.2; rw [e] at this; simp [State.dead] at this⟩
  induction h with
  | refl => exact ⟨hk, by rw [withdrawn_rel]; exact withdrawRow_clears _ _ hkey⟩
  | tail _ st ih => exact dead_step st k ih.1 ih.2

/-! ## Before the guards: the regression proof

`jobs.ts` `reconcile` as it was until the guards were added: it converged whatever release its job
named, whenever the job ran.
-/

namespace Unguarded

inductive Step : Sys → Sys → Prop
  | request (s : Sys) (key : Nat) : Step s (s.push ⟨key, .pending⟩)
  | reconcile (s : Sys) (i : Nat) (hi : i < s.n) : Step s (reconciled s i)
  | withdraw (s : Sys) (key : Nat) : Step s (retireAll .withdrawn key s)
  | spine (s : Sys) (key : Nat) :
      Step s ((retireAll .superseded key s).push ⟨key, .converged⟩)

inductive Reachable : Sys → Prop
  | init : Reachable Sys.init
  | step {s t : Sys} : Reachable s → Step s t → Reachable t

/-- Two releases of one API into one environment, `R0` then `R1`. `R0`'s job throws and backs off;
`R1`'s runs first and converges; `R0`'s retry then converges `R0` and supersedes `R1`.
`test/promotion.test.ts` "release order" drives exactly this trace through the real job runner. -/
theorem older_release_resurrects : ∃ s, Reachable s ∧ ¬ NewestWins s := by
  refine ⟨_, .step (.step (.step (.step .init (.request _ 0)) (.request _ 0))
      (.reconcile _ 1 (by decide))) (.reconcile _ 0 (by decide)), ?_⟩
  intro h
  exact absurd (h 0 1 (by decide) (by decide) (by decide) (by decide)) (by decide)

/-- `R0` is confirmed and its job backs off; the API is withdrawn (which, before the fix, touched
only `converged` rows); `R0`'s retry then publishes it again. `test/promotion.test.ts` "release
order" drives this trace too. -/
theorem withdrawn_then_applied :
    let w := retireAll .withdrawn 0 (Sys.init.push ⟨0, .pending⟩)
    Reachable w ∧ Step w (reconciled w 0) ∧ ((reconciled w 0).rel 0).state = .converged := by
  intro w
  exact ⟨.step (.step .init (.request _ 0)) (.withdraw _ 0), .reconcile _ 0 (by decide), rfl⟩

/-- And a replayed job resurrected a withdrawn release: withdraw `R0`, replay its apply. -/
theorem replay_resurrects_withdrawn :
    ∃ s t, Reachable s ∧ Step s t ∧ (s.rel 0).state = .withdrawn ∧ (t.rel 0).state = .converged :=
  ⟨_, _, .step (.step (.step .init (.request _ 0)) (.reconcile _ 0 (by decide))) (.withdraw _ 0),
    .reconcile _ 0 (by decide), by decide, by decide⟩

end Unguarded

end Release
