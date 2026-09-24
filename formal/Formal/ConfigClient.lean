/-!
# Gateway configuration polling

`data-plane/src/config-client.ts` `ConfigClient.pollOnce` is the only writer of the route table an
instance serves. A poll is two steps with the network between them, and the model has one step
for each:

* `send` — the `fetch` of `/api/gateway/poll`. Sends are numbered in the order they leave.
* `process k` — everything after the last `await` of send `k`'s poll: the synchronous tail that
  either activates the document (`this.table = this.tableFor(config)`), drops the table on a 401 or
  403 (`this.table = null`), or leaves it alone (`unchanged`, `blocked`, a transport error, a 413).

The timer calls `pollOnce` every interval whether or not the last one has returned, and a poll can
outlast an interval: the fetch may take ten seconds and `blockerFor` fetches a new document's
artifacts with no bound at all. So without a guard any number of polls are between `send` and
`process` at once, and they are processed in the order they *finish*. The guard is `inFlight`: a
`pollOnce` that finds it set returns `"skipped"` without sending. The check and the set have no
`await` between them, so in one event loop they are one step; that is `send`'s precondition
`guard = true → s.inflight = []`.

What the control plane answers is a parameter, `ans : Nat → Answer`, read as "what it said to send
`k`". Revocation is permanent (`gateway_instance.revoked_at` is never cleared), so a theorem that
needs it assumes a revoked answer is followed only by revoked answers.

Proved, with the guard: answers are applied in the order they were asked for (`in_order`); the table
is the newest document answered, with nothing but "leave it alone" answered since
(`newest_document_serves`); and once a 401 has been processed, the instance serves nothing again
(`revoked_stays_down`). In the `Unguarded` section, the same steps without the guard: a 200 sent
before the revocation and processed after it puts the routes back (`late_answer_undoes_revocation`),
and an older document is activated over a newer one (`older_document_wins`).

Not modelled: `activationBlocked`. It is a report, not a state anything reads to decide what to
serve; `test/artifacts.test.ts` holds that an `unchanged` answer clears it.
-/

namespace ConfigClient

/-- What one poll's answer does to the served table. -/
inductive Answer where
  /-- A 200 with a document that activates. -/
  | doc
  /-- `unchanged`, `blocked`, a transport error or a 413: the table stays as it is. -/
  | keep
  /-- A 401 or 403: the table is dropped and every request is a 503. -/
  | revoked
  deriving DecidableEq, Repr

structure Sys where
  /-- How many polls have been sent. -/
  next : Nat
  /-- Sent and not yet processed. -/
  inflight : List Nat
  /-- Processed, newest first. -/
  processed : List Nat
  /-- Which send's document is serving, if any. -/
  table : Option Nat
  deriving DecidableEq, Repr

def init : Sys := ⟨0, [], [], none⟩

def apply (a : Answer) (k : Nat) (t : Option Nat) : Option Nat :=
  match a with
  | .doc => some k
  | .keep => t
  | .revoked => none

inductive Step (ans : Nat → Answer) (guard : Bool) : Sys → Sys → Prop
  | send (s : Sys) (h : guard = true → s.inflight = []) :
      Step ans guard s ⟨s.next + 1, s.next :: s.inflight, s.processed, s.table⟩
  | process (s : Sys) (k : Nat) (h : k ∈ s.inflight) :
      Step ans guard s ⟨s.next, s.inflight.erase k, k :: s.processed, apply (ans k) k s.table⟩

inductive Reachable (ans : Nat → Answer) (guard : Bool) : Sys → Prop
  | init : Reachable ans guard init
  | step {s t : Sys} : Reachable ans guard s → Step ans guard s t → Reachable ans guard t

/-- The table that processing these answers, newest first, leaves behind. -/
def serving (ans : Nat → Answer) : List Nat → Option Nat
  | [] => none
  | k :: rest => apply (ans k) k (serving ans rest)

/-- Guarded or not, the table is whatever the answers made it, in the order they were processed. -/
theorem table_follows_processing {ans : Nat → Answer} {g : Bool} {s : Sys}
    (h : Reachable ans g s) : s.table = serving ans s.processed := by
  induction h with
  | init => rfl
  | @step s _ _ hs ih =>
    cases hs with
    | send _ => exact ih
    | process k _ =>
      show apply (ans k) k s.table = apply (ans k) k (serving ans s.processed)
      rw [ih]

/-! ## With the guard -/

/-- `n - 1, …, 1, 0`: every send so far, newest first, each exactly once. -/
def down : Nat → List Nat
  | 0 => []
  | n + 1 => n :: down n

theorem mem_down {j : Nat} : ∀ {n : Nat}, j ∈ down n ↔ j < n
  | 0 => ⟨(fun h => nomatch h), fun h => absurd h (Nat.not_lt_zero _)⟩
  | n + 1 =>
    ⟨fun h => match h with
      | .head _ => Nat.lt_succ_self _
      | .tail _ h' => Nat.lt_succ_of_lt (mem_down.mp h'),
     fun h => if hj : j = n then by rw [hj]; exact .head _
       else .tail _ (mem_down.mpr (Nat.lt_of_le_of_ne (Nat.le_of_lt_succ h) hj))⟩

/-- Either nothing is in flight and every send has been processed, or the newest one is in flight
and every earlier one has been. -/
def InOrder (s : Sys) : Prop :=
  (s.inflight = [] ∧ s.processed = down s.next) ∨
  (∃ k, s.next = k + 1 ∧ s.inflight = [k] ∧ s.processed = down k)

theorem in_order {ans : Nat → Answer} {s : Sys} (h : Reachable ans true s) : InOrder s := by
  induction h with
  | init => exact Or.inl ⟨rfl, rfl⟩
  | @step s _ _ hs ih =>
    cases hs with
    | send hg =>
      have hnil := hg rfl
      rcases ih with ⟨_, hp⟩ | ⟨k, _, hk, _⟩
      · exact Or.inr ⟨s.next, rfl, by rw [hnil], hp⟩
      · rw [hk] at hnil; simp at hnil
    | process k hk =>
      rcases ih with ⟨hi, _⟩ | ⟨j, hn, hj, hp⟩
      · rw [hi] at hk; simp at hk
      · rw [hj] at hk
        have hkj : k = j := by simpa using hk
        refine Or.inl ⟨?_, ?_⟩
        · show s.inflight.erase k = []
          rw [hj, hkj]; simp
        · show k :: s.processed = down s.next
          rw [hn, hp, hkj]; rfl

/-- Answers are applied in the order they were asked for: the processed sends are `down n`. -/
theorem applied_in_send_order {ans : Nat → Answer} {s : Sys} (h : Reachable ans true s) :
    ∃ n, s.processed = down n := by
  rcases in_order h with ⟨_, hp⟩ | ⟨_, _, _, hp⟩
  · exact ⟨_, hp⟩
  · exact ⟨_, hp⟩

theorem serving_down {ans : Nat → Answer} : ∀ {n v : Nat}, serving ans (down n) = some v →
    v < n ∧ ans v = .doc ∧ ∀ j, v < j → j < n → ans j = .keep
  | 0, v, h => by simp [down, serving] at h
  | n + 1, v, h => by
    simp only [down, serving] at h
    cases hn : ans n with
    | doc =>
      rw [hn] at h
      simp only [apply, Option.some.injEq] at h
      exact ⟨by omega, by rw [← h]; exact hn, fun j h1 h2 => by omega⟩
    | keep =>
      rw [hn] at h
      simp only [apply] at h
      obtain ⟨h1, h2, h3⟩ := serving_down h
      refine ⟨by omega, h2, fun j hj1 hj2 => ?_⟩
      by_cases hjn : j = n
      · rw [hjn]; exact hn
      · exact h3 j hj1 (by omega)
    | revoked =>
      rw [hn] at h
      simp [apply] at h

/-- The serving document is the newest one answered: every send processed after it was answered
"leave it alone". An older document can never be activated over a newer one. -/
theorem newest_document_serves {ans : Nat → Answer} {s : Sys} {v : Nat}
    (h : Reachable ans true s) (hv : s.table = some v) :
    ans v = .doc ∧ v ∈ s.processed ∧ ∀ j ∈ s.processed, v < j → ans j = .keep := by
  obtain ⟨n, hp⟩ := applied_in_send_order h
  rw [table_follows_processing h, hp] at hv
  obtain ⟨h1, h2, h3⟩ := serving_down hv
  rw [hp]
  exact ⟨h2, mem_down.mpr h1, fun j hj hvj => h3 j hvj (mem_down.mp hj)⟩

/-- Once a 401 has been processed, the instance serves nothing, for ever: revocation fails closed
and nothing sent before it can undo it. -/
theorem revoked_stays_down {ans : Nat → Answer}
    (hrev : ∀ j k, j ≤ k → ans j = .revoked → ans k = .revoked)
    {s : Sys} (h : Reachable ans true s) {l : Nat} (hl : l ∈ s.processed)
    (hr : ans l = .revoked) : s.table = none := by
  obtain ⟨n, hp⟩ := applied_in_send_order h
  rw [hp, mem_down] at hl
  rw [table_follows_processing h, hp]
  cases n with
  | zero => omega
  | succ m =>
    simp only [down, serving]
    rw [hrev l m (by omega) hr]
    rfl

/-! ## Without the guard: the regression proof -/

namespace Unguarded

/-- Send 0 answered with a document, every later send refused: the instance was revoked between
them. -/
def revokedAfterFirst (k : Nat) : Answer := if k = 0 then .doc else .revoked

theorem revokedAfterFirst_permanent :
    ∀ j k, j ≤ k → revokedAfterFirst j = .revoked → revokedAfterFirst k = .revoked := by
  intro j k hjk h
  by_cases hk : k = 0
  · have hj : j = 0 := by omega
    rw [hj] at h
    simp [revokedAfterFirst] at h
  · simp [revokedAfterFirst, hk]

/-- Two polls in flight; the later one's 401 is processed first, then the earlier one's 200 puts
the routes back. The instance serves after its revocation was applied. -/
theorem late_answer_undoes_revocation :
    ∃ s, Reachable revokedAfterFirst false s ∧ 1 ∈ s.processed ∧
      revokedAfterFirst 1 = .revoked ∧ s.table = some 0 :=
  ⟨_, .step (.step (.step (.step .init (.send _ (by simp))) (.send _ (by simp)))
      (.process _ 1 (by decide))) (.process _ 0 (by decide)),
    by decide, by decide, by decide⟩

/-- Every answer a document; the newer one is processed first and the older one then replaces it. -/
theorem older_document_wins :
    ∃ s, Reachable (fun _ => .doc) false s ∧ 1 ∈ s.processed ∧ s.table = some 0 :=
  ⟨_, .step (.step (.step (.step .init (.send _ (by simp))) (.send _ (by simp)))
      (.process _ 1 (by decide))) (.process _ 0 (by decide)),
    by decide, by decide⟩

end Unguarded

end ConfigClient
