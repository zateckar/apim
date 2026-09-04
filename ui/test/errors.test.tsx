import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError, api, fixOf } from "../src/api.ts";
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
