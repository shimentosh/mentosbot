import { useTimeout } from "@rakazo/chat-ui/hooks";
import type { SearchHit } from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";
import type { createSpaceRpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";
import type { useShellNavigation } from "./use-shell-navigation";

/** The sidebar's search box: it filters the roster and searches the space. */
export function useSidebarSearch({
  rpc,
  navigate,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  navigate: ReturnType<typeof useShellNavigation>["navigate"];
}) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchAttempt, setSearchAttempt] = useState(0);
  const spaceQuery = query.trim();
  const showSpaceSearch = spaceQuery.length > 0;

  // Each query and retry gets its own signal, aborted once a newer one replaces it.
  const searchAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!showSpaceSearch) {
      setSearchHits([]);
      setSearchLoading(false);
      setSearchError(null);
      return;
    }
    const abort = new AbortController();
    searchAbort.current = abort;
    return () => abort.abort();
  }, [showSpaceSearch, spaceQuery, searchAttempt]);
  useTimeout(
    () => {
      const abort = searchAbort.current;
      if (!abort) return;
      setSearchLoading(true);
      setSearchError(null);
      void rpc.search
        .query({ q: spaceQuery }, { signal: abort.signal })
        .then((result) => {
          if (!abort.signal.aborted) setSearchHits(result.hits);
        })
        .catch((error: unknown) => {
          if (!abort.signal.aborted) setSearchError(errorText(error));
        })
        .finally(() => {
          if (!abort.signal.aborted) setSearchLoading(false);
        });
    },
    showSpaceSearch ? 200 : null,
    `${spaceQuery}\n${searchAttempt}`,
  );

  function jumpToSearchHit(hit: SearchHit) {
    setQuery("");
    setSearchOpen(false);
    setSearchHits([]);
    const params = new URLSearchParams();
    if (hit.messageId) params.set("m", hit.messageId);
    if (hit.routineId) params.set("routine", hit.routineId);
    navigate({
      pathname: hit.groupId ? `/app/g/${hit.groupId}` : `/app/${hit.botId}`,
      search: params.toString() ? `?${params.toString()}` : undefined,
    });
  }

  return {
    query,
    setQuery,
    searchOpen,
    setSearchOpen,
    searchHits,
    searchLoading,
    searchError,
    retrySearch: () => {
      setSearchLoading(true);
      setSearchAttempt((attempt) => attempt + 1);
    },
    showSpaceSearch,
    jumpToSearchHit,
  };
}

export type SidebarSearch = ReturnType<typeof useSidebarSearch>;
