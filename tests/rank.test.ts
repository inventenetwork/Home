import { describe, expect, it } from 'vitest';
import { rankCandidates, type Candidate } from '../src/matching/rank.js';

const c = (providerId: string, ratingAvg: number, ratingCount: number, offersReceived = 0): Candidate => ({ providerId, ratingAvg, ratingCount, offersReceived });
const order = (list: Candidate[]) => rankCandidates(list).map((x) => x.providerId);

describe('rankCandidates', () => {
  it('puts better-rated providers first', () => {
    expect(order([c('a', 3.5, 10), c('b', 5, 10), c('c', 4.5, 10)])).toEqual(['b', 'c', 'a']);
  });

  it('treats near-equal ratings as equal (nearest half star) so work rotates to whoever was offered least', () => {
    // 4.6 and 4.4 both round to 4.5
    expect(order([c('a', 4.6, 20, 9), c('b', 4.4, 20, 2)])).toEqual(['b', 'a']);
  });

  it('gives providers with no ratings yet a neutral 4.5', () => {
    expect(order([c('new', 0, 0), c('good', 5, 3), c('meh', 4, 8)])).toEqual(['good', 'new', 'meh']);
  });

  it('is deterministic when everything else ties', () => {
    expect(order([c('b', 4.5, 1, 1), c('a', 4.5, 1, 1)])).toEqual(['a', 'b']);
  });

  it('does not change the list it was given', () => {
    const list = [c('b', 3, 1), c('a', 5, 1)];
    rankCandidates(list);
    expect(list.map((x) => x.providerId)).toEqual(['b', 'a']);
  });
});
