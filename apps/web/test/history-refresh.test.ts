import { QueryClient } from "@tanstack/react-query";
import { Option, Predicate } from "effect";
import { describe, expect, it } from "vitest";
import { capturedRequestQuery, historyRequestsQuery, refreshHistory } from "../src/api/admin.ts";

/** How often the request list asks again while it holds `pages` pages. */
const intervalWith = (pages: number) => {
  const { refetchInterval } = historyRequestsQuery({ days: 1, bucket: "hour" }, {});
  const query = { state: { data: { pages: Array.from({ length: pages }), pageParams: [] } } };

  // SAFETY: `refetchInterval` reads only `state.data.pages` of the query it's handed.
  return Predicate.isFunction(refetchInterval) ? refetchInterval(query as never) : refetchInterval;
};

describe("the request list's refresh", () => {
  it("keeps up every 15 s while it shows its first page", () => {
    expect(intervalWith(1)).toBe(15_000);
  });

  it("holds still once more is loaded, rather than fetching every page again", () => {
    expect(intervalWith(2)).toBe(false);
  });
});

describe("a captured prompt", () => {
  it("is fetched again once the history or its prompts are deleted", () => {
    const queryClient = new QueryClient();
    const { queryKey } = capturedRequestQuery("t2");
    queryClient.setQueryData(queryKey, Option.none());

    refreshHistory(queryClient);

    expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
  });
});
