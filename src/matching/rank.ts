/**
 * Who gets the offer first. Pure, so the rules are easy to read and test.
 *  1. Better-rated providers first. Ratings are rounded to the nearest half star, so near-equal providers rotate
 *     instead of the same top-rated person getting every job.
 *  2. Providers with no ratings yet count as 4.5 stars (a fair start for newcomers).
 *  3. Among equals, whoever has been offered the fewest jobs goes first.
 *  4. Final tie-break on id, so the order is always the same for the same data.
 */
export interface Candidate {
  providerId: string;
  ratingAvg: number;
  ratingCount: number;
  offersReceived: number;
}

export const NEUTRAL_RATING = 4.5;

const effectiveRating = (c: Candidate) => Math.round((c.ratingCount > 0 ? c.ratingAvg : NEUTRAL_RATING) * 2) / 2;

export function rankCandidates<T extends Candidate>(candidates: T[]): T[] {
  return [...candidates].sort(
    (a, b) =>
      effectiveRating(b) - effectiveRating(a) ||
      a.offersReceived - b.offersReceived ||
      a.providerId.localeCompare(b.providerId),
  );
}
