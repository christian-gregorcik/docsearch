export interface Ranking {
  /** Name of the ranker, carried through to the result so a hit can be explained. */
  name: string;
  /** Chunk ids, best first. */
  ids: readonly number[];
}

export interface Fused {
  id: number;
  score: number;
  /** One-based position in each ranking that returned this id. */
  ranks: Record<string, number>;
}

export const DEFAULT_RRF_K = 60;

/**
 * Reciprocal rank fusion.
 *
 * Each ranking contributes 1 / (k + rank) for the items it returned. Only the
 * order within a ranking counts, so a lexical score and a cosine distance can
 * be combined without pretending they are on the same scale. The constant k
 * damps the top of each list; at the default of 60 the first and second place
 * differ by about two percent, which is what keeps one confident ranker from
 * deciding the whole result on its own.
 */
export function fuse(rankings: readonly Ranking[], k: number = DEFAULT_RRF_K): Fused[] {
  if (!Number.isFinite(k) || k <= 0) {
    throw new Error(`rrf k must be a positive number, got ${String(k)}`);
  }
  const merged = new Map<number, Fused>();
  for (const ranking of rankings) {
    ranking.ids.forEach((id, i) => {
      const rank = i + 1;
      const entry = merged.get(id) ?? { id, score: 0, ranks: {} };
      if (entry.ranks[ranking.name] !== undefined) return;
      entry.score += 1 / (k + rank);
      entry.ranks[ranking.name] = rank;
      merged.set(id, entry);
    });
  }
  return [...merged.values()].sort((a, b) => b.score - a.score || a.id - b.id);
}
