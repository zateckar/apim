import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError, api, fixOf, isSessionLost, onSessionLost } from "../src/api.ts";
import { describe as describeError } from "../src/components.tsx";
import { Refusal } from "../src/views/PlaygroundPanel.tsx";

/**
 * A refusal has to arrive where the decision was made (plan §9.4).
 *
 * The control plane answers a refused write with `problem+json`: a `detail` that names what is
 * missing and, on the ones that have a screen behind them, an `extra.fix` saying which. Both have
 * to survive the client, or the UI is back to "something went wrong".
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stands in for the network; `fetch` carries statics this does not, hence the cast through `unknown`. */
function replies(reply: () => Response) {
  globalThis.fetch = (async () => reply()) as unknown as typeof fetch;
}

function answers(status: number, body: unknown) {
  replies(
    () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/problem+json" },
      }),
  );
}

/** The 409 `routeFor` throws when a revision is published but the route cannot be built. */
const NOT_SERVED = {
  type: "about:blank",
  title: "Conflict",
  status: 409,
  detail:
    "petstore v1 is published in DEV but is not currently being served: two APIs claim the base path /petstore/v1",
  fix: { screen: "policy", resourceId: "res_1", environment: "dev" },
};

describe("a refused write", () => {
  test("carries the sentence that names what is missing", async () => {
    answers(409, NOT_SERVED);
    const err = await api.post("/api/playground/send", {}).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(err).toBeInstanceOf(ApiError);
    const problem = err as ApiError;
    expect(problem.status).toBe(409);
    expect(problem.detail).toContain("two APIs claim the base path");
    // What the inline notice shows: the status, the title and the remedy, in one line.
    expect(describeError(problem)).toBe(`409 Conflict: ${NOT_SERVED.detail}`);
  });

  test("carries the screen that fixes it, not only prose about it", async () => {
    answers(409, NOT_SERVED);
    const err = await api.post("/api/playground/send", {}).catch((thrown: unknown) => thrown);
    expect(fixOf(err)).toEqual({ screen: "policy", resourceId: "res_1", environment: "dev" });
  });

  test("a refusal with no fix does not invent one", async () => {
    answers(400, { title: "Bad Request", status: 400, detail: "resourceId is required" });
    const err = await api.get("/api/playground/form").catch((thrown: unknown) => thrown);
    expect(fixOf(err)).toBeNull();
    expect((err as ApiError).detail).toBe("resourceId is required");
  });

  test("a body that is not JSON at all still produces a readable error", async () => {
    replies(() => new Response("upstream is down", { status: 502 }));
    const err = await api.get("/api/meta").catch((thrown: unknown) => thrown);
    expect(err).toBeInstanceOf(ApiError);
    expect(describeError(err)).toContain("upstream is down");
  });
});

describe("a session that has ended", () => {
  /** Runs `body` with a subscription in place, and answers how many times it was told. */
  async function timesTold(body: () => Promise<unknown>): Promise<number> {
    let count = 0;
    const off = onSessionLost(() => count++);
    try {
      await body();
    } finally {
      off();
    }
    return count;
  }

  test("both codes the control plane uses for it are recognised", () => {
    // `no_session` is the router's, for a session past either bound or revoked; `session_expired`
    // is the OIDC refresh's, for one the identity provider has ended. Two producers, one meaning.
    for (const code of ["no_session", "session_expired"]) {
      expect(isSessionLost(new ApiError(401, "Unauthorized", "sign in first", { code })), code).toBe(
        true,
      );
    }
  });

  test("a rejected password is not an expiry, and neither is the provider being down", () => {
    // The distinction the whole mechanism rests on. A 401 from the sign-in form would otherwise
    // re-render the screen the user is already typing into, and a 503 from a provider outage would
    // sign out an estate whose sessions are all perfectly valid.
    expect(
      isSessionLost(
        new ApiError(401, "Unauthorized", "that username and password were not accepted", {
          code: "bad_credentials",
        }),
      ),
    ).toBe(false);
    expect(
      isSessionLost(
        new ApiError(503, "Service Unavailable", "the identity provider could not be reached", {
          code: "auth_backend_unavailable",
        }),
      ),
    ).toBe(false);
    // A 401 with no code at all — `POST /api/auth/password` answers one for a wrong current
    // password — is a refusal of that request, not of the session it arrived on.
    expect(isSessionLost(new ApiError(401, "Unauthorized", "that is not your current password"))).toBe(
      false,
    );
  });

  test("any request that meets it says so, and still throws where it was called", async () => {
    answers(401, { title: "Unauthorized", status: 401, detail: "sign in first", code: "no_session" });
    let thrown: unknown = null;
    const told = await timesTold(async () => {
      thrown = await api.get("/api/dashboard").catch((err: unknown) => err);
    });
    expect(told).toBe(1);
    // The caller's own error handling is untouched: it announces, it does not swallow.
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(401);
  });

  test("an ordinary refusal tells nobody", async () => {
    answers(409, NOT_SERVED);
    const told = await timesTold(() => api.post("/api/playground/send", {}).catch(() => null));
    expect(told).toBe(0);
  });

  test("nothing is told after unsubscribing", async () => {
    answers(401, { title: "Unauthorized", status: 401, detail: "sign in first", code: "no_session" });
    let count = 0;
    onSessionLost(() => count++)();
    await api.get("/api/meta").catch(() => null);
    expect(count).toBe(0);
  });
});

describe("the refusal as the console renders it", () => {
  test("shows the remedy inline and links to the screen the server named", () => {
    const cause = new ApiError(409, "Conflict", NOT_SERVED.detail, NOT_SERVED);
    const html = renderToStaticMarkup(
      <Refusal
        message={describeError(cause)}
        cause={cause}
        resourceId="res_1"
        environment="dev"
      />,
    );
    // The sentence, in the panel — not a toast, and not "409".
    expect(html).toContain("two APIs claim the base path /petstore/v1");
    expect(html).not.toContain("409 Conflict:");
    expect(html).toContain('href="/apis/res_1/policies?environment=dev"');
  });

  test("follows the server's fix rather than the wording of the sentence", () => {
    // Same words, different fix: the link has to move with the `fix`, which is the whole point of
    // the server sending one.
    const cause = new ApiError(409, "Conflict", NOT_SERVED.detail, {
      ...NOT_SERVED,
      fix: { screen: "publish", resourceId: "res_9", environment: "test" },
    });
    const html = renderToStaticMarkup(
      <Refusal message={describeError(cause)} cause={cause} resourceId="res_1" environment="dev" />,
    );
    expect(html).toContain('href="/apis/res_9/publish?environment=test"');
  });

  test("falls back to this API's publishing screen when the server named none", () => {
    const html = renderToStaticMarkup(
      <Refusal message="No gateway is configured for DEV." resourceId="res_1" environment="dev" />,
    );
    expect(html).toContain('href="/apis/res_1/publish?environment=dev"');
    expect(html).toContain("No gateway is configured for DEV.");
  });
});
