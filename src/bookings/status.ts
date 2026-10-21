/**
 * Booking status machine. Pure: it only answers "may this actor move a booking from A to B?".
 * Ownership checks (is this THEIR booking / assigned job?) are done by the routes.
 */

export const BOOKING_STATUSES = [
  'pending', // created, waiting for payment (holds the slot for a limited time)
  'offered', // paid; offered to nearby providers (step 5)
  'confirmed', // a provider is assigned
  'on_the_way',
  'in_progress',
  'completed',
  'paid_out',
  'cancelled',
  'disputed',
] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];
export type Actor = 'customer' | 'provider' | 'admin' | 'system';

const RULES: Record<BookingStatus, Partial<Record<BookingStatus, Actor[]>>> = {
  pending: { offered: ['system', 'admin'], confirmed: ['admin'], cancelled: ['customer', 'admin', 'system'] },
  offered: { confirmed: ['provider', 'admin'], cancelled: ['customer', 'admin', 'system'] },
  confirmed: { on_the_way: ['provider', 'admin'], offered: ['admin'], cancelled: ['customer', 'admin'] },
  on_the_way: { in_progress: ['provider', 'admin'], cancelled: ['admin'] },
  in_progress: { completed: ['provider', 'admin'], cancelled: ['admin'] },
  completed: { paid_out: ['system', 'admin'], disputed: ['customer', 'admin'] },
  paid_out: {},
  disputed: { completed: ['admin'], paid_out: ['admin'], cancelled: ['admin'] },
  cancelled: {},
};

export function canTransition(from: BookingStatus, to: BookingStatus, actor: Actor): boolean {
  return RULES[from]?.[to]?.includes(actor) ?? false;
}

export function allowedNext(from: BookingStatus, actor: Actor): BookingStatus[] {
  return (Object.entries(RULES[from] ?? {}) as Array<[BookingStatus, Actor[]]>)
    .filter(([, actors]) => actors.includes(actor))
    .map(([to]) => to);
}

export class TransitionError extends Error {
  constructor(
    public readonly code: 'not_found' | 'invalid_transition',
    message: string,
  ) {
    super(message);
    this.name = 'TransitionError';
  }
}
