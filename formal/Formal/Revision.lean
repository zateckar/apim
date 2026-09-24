/-!
# Revisions: freeze, correct, prune

One `revision` row, and every statement that writes the three columns that decide whether its
definition may still change: `frozen_at`, `pruned_at` and the definition itself (`version_digest`
stands for it — a correction always writes a new one, and one digest is never written twice).

* `check i` — `api/resources.ts` `PUT /api/revisions/:id/spec`, up to its first `await`: correction
  `i` finds the revision neither frozen nor pruned and reads its digest (the `If-Match` it is held
  to).
* `write i` — the same handler after the body is read and the definition fetched, which may take as
  long as a `specUrl` takes to answer. Fixed, the `UPDATE` re-states all three checks as its own
  `WHERE`; unguarded, it wrote whatever the revision had become.
* `refuse i` — that `UPDATE` changed nothing, and the handler answers 409.
* `release` — `api/promotion.ts`: `frozen_at = COALESCE(frozen_at, ?)`. It refuses a pruned
  revision, and has no `await` between that check and the write.
* `queue` — `operations.ts` `queue`: an operation that will publish the revision when its turn
  comes, confirmed against the digest it has now. Fixed, the revision freezes here; before, only
  when the operation was applied.
* `apply` — `operations.ts` `runOperations` applies it.
* `prune` — `retention.ts` `pruneRevisions`. Fixed, it passes over a revision an operation has not
  yet applied; its other exceptions (released, rollback target, live plan) are not modelled, so it
  may otherwise prune at any moment — the worst case.

The config build reads a released revision's definition on every poll, so a definition that
changes after its revision is released is served without a release. Proved, fixed: a frozen
revision's definition never changes again and a pruned one's stays gone (`frozen_forever`,
`pruned_forever`); a correction only replaces the definition its author read (`no_lost_correction`);
and while an operation waits, the revision holds exactly what it was confirmed against and is not
pruned (`waits_for_what_was_confirmed`). The `Unguarded` section is the regression proof for each.
-/

namespace Revision

structure Sys where
  frozen : Bool
  pruned : Bool
  /-- The definition, as its digest. -/
  digest : Nat
  /-- The next digest a correction writes; digests never repeat. -/
  fresh : Nat
  /-- Correction `i` has passed its checks and read this digest. -/
  handler : Nat → Option Nat
  /-- An operation waiting to publish the revision, with the digest it was confirmed against. -/
  queued : Option Nat

def init : Sys := ⟨false, false, 0, 1, fun _ => none, none⟩

def upd (h : Nat → Option Nat) (i : Nat) (v : Option Nat) : Nat → Option Nat :=
  fun j => if j = i then v else h j

inductive Step (fixed : Bool) : Sys → Sys → Prop
  | check (s : Sys) (i : Nat) (hf : s.frozen = false) (hp : s.pruned = false) :
      Step fixed s { s with handler := upd s.handler i (some s.digest) }
  | write (s : Sys) (i d : Nat) (hh : s.handler i = some d)
      (hg : fixed = true → s.frozen = false ∧ s.pruned = false ∧ s.digest = d) :
      Step fixed s { s with digest := s.fresh, fresh := s.fresh + 1, handler := upd s.handler i none }
  | refuse (s : Sys) (i d : Nat) (hh : s.handler i = some d) :
      Step fixed s { s with handler := upd s.handler i none }
  | release (s : Sys) (hp : s.pruned = false) : Step fixed s { s with frozen := true }
  | queue (s : Sys) (hp : s.pruned = false) (hq : s.queued = none) :
      Step fixed s { s with frozen := s.frozen || fixed, queued := some s.digest }
  | apply (s : Sys) (d : Nat) (hq : s.queued = some d) : Step fixed s { s with queued := none }
  | prune (s : Sys) (hw : fixed = true → s.queued = none) : Step fixed s { s with pruned := true }

inductive Reachable (fixed : Bool) : Sys → Prop
  | init : Reachable fixed init
  | step {s t : Sys} : Reachable fixed s → Step fixed s t → Reachable fixed t

inductive Steps (fixed : Bool) : Sys → Sys → Prop
  | refl (s : Sys) : Steps fixed s s
  | tail {s t u : Sys} : Steps fixed s t → Step fixed t u → Steps fixed s u

/-! ## Fixed -/

theorem frozen_step {s t : Sys} (h : Step true s t) (hf : s.frozen = true) :
    t.frozen = true ∧ t.digest = s.digest := by
  cases h with
  | check _ _ _ => exact ⟨hf, rfl⟩
  | write _ _ _ hg =>
    have h1 := (hg rfl).1
    rw [h1] at hf; cases hf
  | refuse _ _ _ => exact ⟨hf, rfl⟩
  | release _ => exact ⟨rfl, rfl⟩
  | queue _ _ => exact ⟨by simp, rfl⟩
  | apply _ _ => exact ⟨hf, rfl⟩
  | prune _ => exact ⟨hf, rfl⟩

/-- Once released — or queued to be — a revision's definition never changes again, which is what
lets the config build read it on every poll. -/
theorem frozen_forever {s t : Sys} (h : Steps true s t) (hf : s.frozen = true) :
    t.frozen = true ∧ t.digest = s.digest := by
  induction h with
  | refl => exact ⟨hf, rfl⟩
  | tail _ hs ih =>
    have := frozen_step hs ih.1
    exact ⟨this.1, this.2.trans ih.2⟩

theorem pruned_step {s t : Sys} (h : Step true s t) (hp : s.pruned = true) :
    t.pruned = true ∧ t.digest = s.digest := by
  cases h with
  | check _ _ _ => exact ⟨hp, rfl⟩
  | write _ _ _ hg =>
    have h1 := (hg rfl).2.1
    rw [h1] at hp; cases hp
  | refuse _ _ _ => exact ⟨hp, rfl⟩
  | release _ => exact ⟨hp, rfl⟩
  | queue _ _ => exact ⟨hp, rfl⟩
  | apply _ _ => exact ⟨hp, rfl⟩
  | prune _ => exact ⟨rfl, rfl⟩

/-- A tombstone stays a tombstone: no correction writes a definition back into it. -/
theorem pruned_forever {s t : Sys} (h : Steps true s t) (hp : s.pruned = true) :
    t.pruned = true ∧ t.digest = s.digest := by
  induction h with
  | refl => exact ⟨hp, rfl⟩
  | tail _ hs ih =>
    have := pruned_step hs ih.1
    exact ⟨this.1, this.2.trans ih.2⟩

/-- Whenever the definition changes, the correction that changed it had read the definition it
replaced: two corrections that read the same one cannot both land. -/
theorem no_lost_correction {s t : Sys} (h : Step true s t) (hd : t.digest ≠ s.digest) :
    ∃ i, s.handler i = some s.digest := by
  cases h with
  | write i d hh hg =>
    rw [(hg rfl).2.2]
    exact ⟨i, hh⟩
  | check _ _ _ => exact absurd rfl hd
  | refuse _ _ _ => exact absurd rfl hd
  | release _ => exact absurd rfl hd
  | queue _ _ => exact absurd rfl hd
  | apply _ _ => exact absurd rfl hd
  | prune _ => exact absurd rfl hd

/-- While an operation waits, the revision holds what it was confirmed against, frozen and alive. -/
def Waiting (s : Sys) : Prop :=
  ∀ d, s.queued = some d → s.digest = d ∧ s.pruned = false ∧ s.frozen = true

theorem waiting_step {s t : Sys} (h : Step true s t) (hi : Waiting s) : Waiting t := by
  cases h with
  | check _ _ _ => exact hi
  | write _ _ _ hg =>
    intro d hq
    have hfz := (hi d hq).2.2
    rw [(hg rfl).1] at hfz; cases hfz
  | refuse _ _ _ => exact hi
  | release _ => intro d hq; exact ⟨(hi d hq).1, (hi d hq).2.1, rfl⟩
  | queue hp _ =>
    intro d hq
    simp only [Option.some.injEq] at hq
    exact ⟨hq, hp, by simp⟩
  | apply _ _ => intro d hq; exact absurd hq (by simp)
  | prune hw => intro d hq; exact absurd hq (by simp [hw rfl])

theorem reachable_waiting {s : Sys} (h : Reachable true s) : Waiting s := by
  induction h with
  | init => intro d hq; exact absurd hq (by simp [init])
  | step _ hs ih => exact waiting_step hs ih

theorem waits_for_what_was_confirmed {s : Sys} (h : Reachable true s) {d : Nat}
    (hq : s.queued = some d) : s.digest = d ∧ s.pruned = false :=
  ⟨(reachable_waiting h d hq).1, (reachable_waiting h d hq).2.1⟩

/-! ## Unguarded: the regression proof -/

namespace Unguarded

/-- A correction passes its checks, the revision is released while its definition is fetched, and
the write lands anyway: a released revision's definition changes. -/
theorem correction_rewrites_released :
    ∃ s t, Reachable false s ∧ Step false s t ∧ s.frozen = true ∧ t.digest ≠ s.digest :=
  ⟨_, _, .step (.step .init (.check _ 0 rfl rfl)) (.release _ rfl),
    .write _ 0 0 (by decide) (by simp), rfl, by decide⟩

/-- Two corrections read the same definition; the second overwrites the first, whose author it
never saw. -/
theorem lost_correction :
    ∃ s t, Reachable false s ∧ s.handler 1 = some 0 ∧ s.digest ≠ 0 ∧ Step false s t ∧
      t.digest ≠ s.digest :=
  ⟨_, _, .step (.step (.step .init (.check _ 0 rfl rfl)) (.check _ 1 rfl rfl))
      (.write _ 0 0 (by decide) (by simp)),
    by decide, by decide, .write _ 1 0 (by decide) (by simp), by decide⟩

/-- An operation queued without freezing, then a correction: what it will publish is not what was
confirmed. -/
theorem queued_then_corrected :
    ∃ s, Reachable false s ∧ s.queued = some 0 ∧ s.digest ≠ 0 :=
  ⟨_, .step (.step (.step .init (.queue _ rfl rfl)) (.check _ 0 (by decide) rfl))
      (.write _ 0 0 (by decide) (by simp)),
    by decide, by decide⟩

/-- An operation queued, then retention: it will publish a tombstone. -/
theorem queued_then_pruned :
    ∃ s, Reachable false s ∧ s.queued = some 0 ∧ s.pruned = true :=
  ⟨_, .step (.step .init (.queue _ rfl rfl)) (.prune _ (by simp)), by decide, rfl⟩

end Unguarded

end Revision
