import { describe, expect, test } from "bun:test";
import { catalogSearch, readCatalogSearch, type CatalogState } from "../src/views/MarketView.tsx";
import { listingTab } from "../src/views/MarketListing.tsx";
import { callExample, perPeriod, periodLabel } from "../src/views/SubscriptionView.tsx";
import { catalogAccessChip, listingAccessChip } from "../src/lib/status.ts";

/**
 * The catalogue and one subscription, as decisions: what the address says, which tab it opens,
 * and the call a consumer is handed to paste. None of it needs a control plane, and all of it was
 * wrong in a way a screenshot would not show — a filter that a reload forgot, a tab the address
 * could not name, a curl line whose key the shell never expanded.
 */

const meta = { chain: ["dev", "test", "prod"], kinds: ["rest", "soap", "mcp", "a2a"] };
const empty: CatalogState = { q: "", kind: null, tag: null, application: "", environment: "", sort: "relevance" };

describe("the catalogue's address", () => {
  test("an unfiltered catalogue is the bare address", () => {
    expect(catalogSearch(empty)).toBe("");
  });

  test("every filter survives a round trip through the address", () => {
    const state: CatalogState = { q: "pet store", kind: "mcp", tag: "orders", application: "application_sales", environment: "test", sort: "newest" };
    const search = catalogSearch(state);
    // The publisher filter is named for its control, not for the API parameter behind it.
    expect(search).toContain("publisher=application_sales");
    expect(readCatalogSearch(search, meta)).toEqual(state);
  });

  test("an edited address the search would refuse is dropped rather than sent", () => {
    // A 400 for a typo in a bookmark is an error the reader did not cause and cannot read.
    expect(readCatalogSearch("?kind=graphql&environment=staging&sort=random&q=x", meta)).toEqual({ ...empty, q: "x" });
  });
});

describe("the listing's tabs", () => {
  test("the address names the tab", () => {
    expect(listingTab("start", 1)).toBe("start");
    expect(listingTab("try", 3)).toBe("try");
  });

  test("an unknown tab, or none, opens Overview", () => {
    expect(listingTab(null, 1)).toBe("overview");
    expect(listingTab("policy", 1)).toBe("overview");
  });

  test("Versions is offered only when there is more than one", () => {
    expect(listingTab("versions", 1)).toBe("overview");
    expect(listingTab("versions", 2)).toBe("versions");
  });
});

describe("the call a consumer is handed", () => {
  const url = "https://gw.dev.internal/petstore/v1/";

  test("the key goes where the API's own unit says, and the shell expands it", () => {
    const line = callExample("rest", url, { in: "header", name: "X-Api-Key" }, [
      { method: "POST", path: "/pet" },
      { method: "GET", path: "/pet/{petId}" },
      { method: "GET", path: "/store/inventory" },
    ]);
    // A GET that works as pasted, not the first operation in the document.
    expect(line).toBe('curl "https://gw.dev.internal/petstore/v1/store/inventory" -H "X-Api-Key: $SUBSCRIPTION_KEY"');
    expect(callExample("rest", url, { in: "query", name: "key" })).toBe(
      'curl "https://gw.dev.internal/petstore/v1?key=$SUBSCRIPTION_KEY"',
    );
  });

  test("an API that asks for no key is not handed one", () => {
    expect(callExample("rest", url, null)).toBe('curl "https://gw.dev.internal/petstore/v1"');
  });

  test("each kind is called its own way", () => {
    expect(callExample("mcp", url, null)).toContain('"method":"tools/list"');
    expect(callExample("a2a", url, null)).toContain('"method":"message/send"');
    expect(callExample("soap", url, null)).toContain("--data-binary @request.xml");
  });
});

describe("limits, read aloud", () => {
  test("a period keeps its exact duration in the largest unit that divides it", () => {
    expect(periodLabel(60)).toBe("1 minute");
    expect(periodLabel(2_592_000)).toBe("30 days");
    expect(periodLabel(90)).toBe("90 seconds");
    expect(perPeriod(3600)).toBe("per hour");
    expect(perPeriod(7200)).toBe("per 2 hours");
  });
});

describe("the reader's access, named", () => {
  test("a listing says where the access works and whose it is", () => {
    const chip = listingAccessChip("active", ["DEV", "TEST"], ["Platform Application"]);
    expect(chip.label).toBe("Subscribed in DEV, TEST");
    expect(chip.title).toContain("Platform Application");
    expect(listingAccessChip("waiting", ["PROD"], ["Platform Application"]).tone).toBe("wait");
  });

  test("a card says whether it can be asked for at all", () => {
    expect(catalogAccessChip({ subscribed: true, products: [{}] }).label).toBe("Subscribed");
    expect(catalogAccessChip({ subscribed: false, products: [{}] }).label).toBe("Available to subscribe");
    expect(catalogAccessChip({ subscribed: false, products: [] }).label).toBe("Not in a product");
  });
});
