import { describe, expect, it } from 'vitest';
import { allowedNext, BOOKING_STATUSES, canTransition } from '../src/bookings/status.js';

describe('booking status machine', () => {
  it('follows the happy path with the right actors', () => {
    expect(canTransition('pending', 'offered', 'system')).toBe(true);
    expect(canTransition('offered', 'confirmed', 'provider')).toBe(true);
    expect(canTransition('confirmed', 'on_the_way', 'provider')).toBe(true);
    expect(canTransition('on_the_way', 'in_progress', 'provider')).toBe(true);
    expect(canTransition('in_progress', 'completed', 'provider')).toBe(true);
    expect(canTransition('completed', 'paid_out', 'system')).toBe(true);
  });

  it('does not let customers drive the job', () => {
    expect(canTransition('confirmed', 'on_the_way', 'customer')).toBe(false);
    expect(canTransition('in_progress', 'completed', 'customer')).toBe(false);
    expect(canTransition('completed', 'paid_out', 'customer')).toBe(false);
  });

  it('does not let providers cancel, pay themselves, or skip steps', () => {
    expect(canTransition('confirmed', 'cancelled', 'provider')).toBe(false);
    expect(canTransition('completed', 'paid_out', 'provider')).toBe(false);
    expect(canTransition('confirmed', 'in_progress', 'provider')).toBe(false);
    expect(canTransition('confirmed', 'completed', 'provider')).toBe(false);
  });

  it('lets customers cancel only before the job starts', () => {
    for (const from of ['pending', 'offered', 'confirmed'] as const) {
      expect(canTransition(from, 'cancelled', 'customer')).toBe(true);
    }
    for (const from of ['on_the_way', 'in_progress', 'completed', 'paid_out'] as const) {
      expect(canTransition(from, 'cancelled', 'customer')).toBe(false);
    }
  });

  it('lets customers dispute only completed jobs', () => {
    expect(canTransition('completed', 'disputed', 'customer')).toBe(true);
    expect(canTransition('in_progress', 'disputed', 'customer')).toBe(false);
    expect(canTransition('paid_out', 'disputed', 'customer')).toBe(false);
  });

  it('treats cancelled and paid_out as final', () => {
    for (const to of BOOKING_STATUSES) {
      for (const actor of ['customer', 'provider', 'admin', 'system'] as const) {
        expect(canTransition('cancelled', to, actor)).toBe(false);
        expect(canTransition('paid_out', to, actor)).toBe(false);
      }
    }
  });

  it('lists what an actor may do next', () => {
    expect(allowedNext('confirmed', 'provider')).toEqual(['on_the_way']);
    expect(allowedNext('confirmed', 'customer')).toEqual(['cancelled']);
    expect(allowedNext('cancelled', 'admin')).toEqual([]);
  });
});
