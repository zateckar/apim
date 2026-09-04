/**
 * Bulkheads (plan G7).
 *
 * The failure this exists to prevent: one backend stops answering, requests to it keep arriving,
 * and because each one waits for its timeout before giving up, the number parked on that backend
 * grows to roughly `arrival rate × timeout`. Every one of them holds a client socket, an upstream
 * socket and its buffers. The gateway is not busy — a parked request costs almost no CPU — it
 * simply runs out of the things it holds, and when it does it takes down every *other* route on
 * the same instance. A slow backend becoming a total outage is the thing to prevent.
 *
 * Two counters, therefore, and no queue:
 *
 *  - **per route**, from the `concurrency` policy unit, so a sick backend fills its own bucket and
 *    nobody else's. This is the control that turns a total outage into a partial one.
 *  - **per instance**, from `MAX_CONCURRENT_REQUESTS`, as the backstop for everything the
 *    per-route ceilings did not anticipate: routes with no unit attached, many routes each a
 *    little over, or one route configured higher than the process can actually carry.
 *
 * No queue, deliberately. Queueing an overload does not shed it, it defers it, and a request that
 * waits in a queue and *then* waits for a timeout is worse than one refused immediately. Design
 * section 8.4 makes the same call for the validation pool ("never queues unboundedly and never
 * backpressures the request path"), and section 5.8 for streams, which shed at
 * `MAX_CONCURRENT_UPGRADES` with a 503.
 */

export type Admission = "ok" | "route-saturated" | "instance-saturated";

export interface GateSnapshot {
  inFlight: number;
  max: number;
  /** Routes currently holding a slot, worst first. Empty when nothing is in flight. */
  routes: Array<{ resourceId: string; inFlight: number }>;
  shedRoute: number;
  shedInstance: number;
}

export class ConcurrencyGate {
  private readonly perRoute = new Map<string, number>();
  private total = 0;
  private shedRoute = 0;
  private shedInstance = 0;

  constructor(readonly maxTotal: number) {}

  /**
   * Take a slot, or say which ceiling refused it.
   *
   * The route's own ceiling is checked first so the answer attributes the refusal correctly: a
   * route over its own limit is a statement about that backend, while a route under its limit
   * refused by the instance ceiling is a statement about the gateway's total load — usually
   * caused by some *other* route. Reversing the order would report every overload as a whole-
   * gateway problem and hide which backend caused it.
   */
  tryAcquire(resourceId: string, routeMax: number | undefined): Admission {
    const current = this.perRoute.get(resourceId) ?? 0;
    if (routeMax !== undefined && current >= routeMax) {
      this.shedRoute++;
      return "route-saturated";
    }
    if (this.total >= this.maxTotal) {
      this.shedInstance++;
      return "instance-saturated";
    }
    this.perRoute.set(resourceId, current + 1);
    this.total++;
    return "ok";
  }

  /** Must be paired with every `ok`, in a `finally`; an unreleased slot is a permanent leak. */
  release(resourceId: string): void {
    const current = this.perRoute.get(resourceId);
    if (current === undefined) return;
    // Deleting at zero keeps the map the size of the *busy* routes rather than of every route
    // ever called, so a config with thousands of routes costs nothing while they are idle.
    if (current <= 1) this.perRoute.delete(resourceId);
    else this.perRoute.set(resourceId, current - 1);
    this.total = Math.max(0, this.total - 1);
  }

  get inFlight(): number {
    return this.total;
  }

  snapshot(): GateSnapshot {
    return {
      inFlight: this.total,
      max: this.maxTotal,
      routes: [...this.perRoute.entries()]
        .map(([resourceId, inFlight]) => ({ resourceId, inFlight }))
        .sort((a, b) => b.inFlight - a.inFlight)
        .slice(0, 10),
      shedRoute: this.shedRoute,
      shedInstance: this.shedInstance,
    };
  }
}
