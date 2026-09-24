/-!
# The circuit breaker

`shared/backend.ts` `CircuitBreaker`, one entry per instance per `(resource, backend)`
(spec `backend-integration-surface`, "A backend keeps failing"). Each function below is the method
of the same name, statement for statement; times are milliseconds and never go backwards.

* `observe` is `state()`: an `open` entry whose `openSec` has elapsed becomes `half-open` with its
  probe count reset. It is lazy — nothing happens until somebody asks.
* `tryAcquire` admits a request, reserving a probe slot when `half-open`.
* `onSuccess` / `onFailure` are called when an admitted request finishes. They release a probe slot
  whatever state the request was admitted in, and `onFailure` reads the stored state rather than
  calling `observe`.

Proved: the probe counter never exceeds `halfOpenProbes`; an open breaker admits nothing until
`openSec` has passed and then admits a probe; `failures` failures inside the window trip a closed
breaker.

Shown by example, both about requests that were admitted in one state and finish in another:

* the *counter* is bounded but the number of probes actually in flight is not — a probe that
  outlives `openSec` is forgotten when the breaker re-opens and half-opens again;
* a failure from a request admitted before the breaker opened re-opens it from *now*, so a burst of
  slow failures pushes the probe interval out past `openSec` after the trip.
-/

namespace Breaker

inductive BState where
  | closed | «open» | halfOpen
  deriving DecidableEq, Repr

structure Settings where
  failures : Nat
  windowMs : Nat
  openMs : Nat
  probes : Nat

structure Entry where
  state : BState
  failures : List Nat
  openedAt : Nat
  probes : Nat
  deriving DecidableEq, Repr

/-- `entry()` for a key never seen: `{ failures: [], state: "closed", openedAtMs: 0, probesInFlight: 0 }`. -/
def Entry.fresh : Entry := ⟨.closed, [], 0, 0⟩

def observe (c : Settings) (now : Nat) (e : Entry) : Entry :=
  if e.state = .open ∧ now - e.openedAt ≥ c.openMs then { e with state := .halfOpen, probes := 0 }
  else e

def tryAcquire (c : Settings) (now : Nat) (e : Entry) : Bool × Entry :=
  let e := observe c now e
  match e.state with
  | .open => (false, e)
  | .halfOpen => if e.probes ≥ c.probes then (false, e) else (true, { e with probes := e.probes + 1 })
  | .closed => (true, e)

/-- `Math.max(0, probesInFlight - 1)` is `Nat` subtraction. -/
def onSuccess (e : Entry) : Entry :=
  { e with probes := e.probes - 1, failures := [], state := .closed }

/-- `failures.filter(at => at > now - windowMs)`, written without subtraction. -/
def onFailure (c : Settings) (now : Nat) (e : Entry) : Entry :=
  let e := { e with probes := e.probes - 1 }
  if e.state = .halfOpen then { e with state := .open, openedAt := now, failures := [] }
  else
    let fs := e.failures.filter (fun t => decide (t + c.windowMs > now)) ++ [now]
    if fs.length ≥ c.failures then { e with state := .open, openedAt := now, failures := [] }
    else { e with failures := fs }

/-! ## The probe counter is bounded -/

def ProbeBound (c : Settings) (e : Entry) : Prop := e.state = .halfOpen → e.probes ≤ c.probes

theorem observe_bound (c : Settings) (now : Nat) (e : Entry) (h : ProbeBound c e) :
    ProbeBound c (observe c now e) := by
  unfold observe; split
  · intro _; exact Nat.zero_le _
  · exact h

theorem tryAcquire_bound (c : Settings) (now : Nat) (e : Entry) (h : ProbeBound c e) :
    ProbeBound c (tryAcquire c now e).2 := by
  have ho := observe_bound c now e h
  unfold tryAcquire
  generalize observe c now e = o at ho ⊢
  cases hs : o.state with
  | «open» => simp only [hs]; exact ho
  | closed => simp only [hs]; exact ho
  | halfOpen =>
    simp only [hs]; split
    · exact ho
    · intro _; simp only; omega

theorem onSuccess_bound (c : Settings) (e : Entry) : ProbeBound c (onSuccess e) := by
  intro h; simp [onSuccess] at h

theorem onFailure_bound (c : Settings) (now : Nat) (e : Entry) (h : ProbeBound c e) :
    ProbeBound c (onFailure c now e) := by
  unfold onFailure; simp only
  split
  · intro h'; simp at h'
  · split
    · intro h'; simp at h'
    · intro h'; simp only at h' ⊢; have := h h'; omega

/-! ## Open means closed to traffic, until the probe interval -/

theorem open_rejects (c : Settings) (now : Nat) (e : Entry) (hs : e.state = .open)
    (hmono : e.openedAt ≤ now) (ht : now < e.openedAt + c.openMs) : (tryAcquire c now e).1 = false := by
  have : observe c now e = e := by
    unfold observe; split
    · next h => have := h.2; omega
    · rfl
  simp [tryAcquire, this, hs]

theorem open_admits_probe_after (c : Settings) (now : Nat) (e : Entry) (hs : e.state = .open)
    (ht : e.openedAt + c.openMs ≤ now) (hp : 0 < c.probes) : (tryAcquire c now e).1 = true := by
  have : observe c now e = { e with state := .halfOpen, probes := 0 } := by
    unfold observe; split
    · rfl
    · next h => exact absurd ⟨hs, by omega⟩ h
  unfold tryAcquire; rw [this]; dsimp only; split
  · omega
  · rfl

/-! ## Enough failures inside the window trip it -/

theorem trips (c : Settings) (now : Nat) (e : Entry) (hs : e.state = .closed)
    (hin : ∀ t ∈ e.failures, t + c.windowMs > now) (hn : c.failures ≤ e.failures.length + 1) :
    (onFailure c now e).state = .open := by
  have hf : e.failures.filter (fun t => decide (t + c.windowMs > now)) = e.failures :=
    List.filter_eq_self.mpr (fun t ht => by simpa using hin t ht)
  simp [onFailure, hs, hf, hn]

/-! ## Requests that finish in a different state from the one they were admitted in

Both scenarios use one failure to trip, a 10 ms probe interval and one probe.
-/

def demo : Settings := ⟨1, 100, 10, 1⟩

/-- A, B admitted while closed at t=0; A fails and trips it. -/
def tripped : Entry :=
  let e := (tryAcquire demo 0 Entry.fresh).2
  let e := (tryAcquire demo 0 e).2
  onFailure demo 0 e

/-- At t=10 probe P1 is admitted; B — admitted back when closed — fails, and the breaker re-opens
with P1 still outstanding. At t=20 probe P2 is admitted. P1 has not finished. -/
def twoProbes : Bool × Bool × BState × BState :=
  let (p1, e) := tryAcquire demo 10 tripped
  let s1 := e.state
  let e := onFailure demo 10 e
  let (p2, e) := tryAcquire demo 20 e
  (p1, p2, s1, e.state)

/-- Two requests admitted as half-open probes and in flight together, with `halfOpenProbes = 1`. -/
theorem probe_budget_exceeded : twoProbes = (true, true, .halfOpen, .halfOpen) := by decide

/-- One request admitted before the trip fails at t=5. At t=10 — `openSec` after the trip — the
breaker still refuses, because the failure moved `openedAt` to 5. Without it, t=10 admits a probe. -/
theorem stale_failure_extends_open :
    (tryAcquire demo 10 tripped).1 = true ∧
    (tryAcquire demo 10 (onFailure demo 5 tripped)).1 = false := by decide

end Breaker
