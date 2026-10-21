# Home360 API

Backend for Home360, an on-demand home services marketplace for Malaysia (cleaning, ironing, aircon servicing, with grass cutting and glass cleaning ready to switch on).

**Status: steps 1–10 of 10, plus the customer web app and Google sign-in**: schema, migrations, seed data,
email-code and Google login, JWT sessions and role guards, service catalogue API, price calculator, admin
catalogue editing, addresses, availability slots, bookings with a status machine, manual provider assignment,
automatic matching (top-3 offers, 15-minute timeout, admin fallback), payments with refunds (behind a gateway interface, pretend gateway for now),
and a web app for customers, providers and admins (English and Bahasa Malaysia) served by the same server.
Providers apply in the app (profile, bank details, ID photos), admins vet them, providers set working hours and days off, take before/after photos, and withdraw earnings that an admin pays by bank transfer.
Customers can repeat bookings on a plan, chat with their provider, review finished jobs and report problems; admins settle disputes. Admins get an overview with reports and a CSV export, user management, editable settings, an audit log viewer, and a handover list for jobs whose provider can no longer do them. Terms of Use and Privacy Notice pages (English and Malay) and PDPA tools (correct my details, download my data, delete my account) are built in. A real payment gateway comes next.

## Requirements

- Node.js 20 or newer (`node -v`)
- Nothing else for development: the database is an embedded Postgres (PGlite) stored in `./data/pglite`
- A real PostgreSQL 14+ for production (`DATABASE_URL`)

## Setup (Windows PowerShell, macOS and Linux are the same)

```
cd C:\dev\home360
npm install
copy .env.example .env
```

Open `.env` and fill in the two secrets. Generate each with:

```
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Put one value in `JWT_SECRET` and a different one in `OTP_SECRET`. Set `ADMIN_EMAIL` to your own email to get an admin account.

```
npm test            # run the test suite first
npm run db:seed     # creates tables, then areas, services, options, config and your admin user
npm run dev         # http://localhost:3000
```

In development with no `SMTP_HOST`, login codes are **printed in the server console** instead of emailed.

## Use the web app

Start the server (`npm run dev`) and open **http://localhost:3000**. There is no separate front-end build or dev server.

| Screen | What it does |
|---|---|
| Home | Services with live "from" prices |
| Book a service | Options and quantity, live price, address (add one inline), date chips and free time slots, notes |
| Login | Email code, or Google if `GOOGLE_CLIENT_ID` is set. The booking form is saved while you log in |
| My bookings | List, detail with price breakdown, **pay** (FPX or e-wallet), payment and refund status, cancel (inline confirm), book again. An open booking refreshes itself every 20 s |
| Job offers (provider) | Offers with a live countdown, earnings and area only; accept or decline. The street address appears after accepting |
| My jobs (provider) | Upcoming and past jobs with full address; buttons for "on my way", "start", "finish" |
| Provider profile | The application: details, areas, services, bank account, ID and selfie photos (taken or chosen on the phone, shrunk in the browser), send for review. Shows the admin's reason if rejected |
| Calendar (provider) | Weekly working hours (several windows a day) and whole days off; customers can only book inside these |
| Earnings (provider) | Available, not yet available, requested and paid amounts; withdraw; per-job history |
| Admin | "Needs attention" list (bookings nobody accepted), all bookings with payment status, assign a provider, cancel (refunds automatically), retry a refund the gateway did not confirm |

Files live in `web/` (plain ES modules, no framework). Text is in `web/js/i18n.js` (EN and BM). Group titles for
option groups come from `group.<key>` entries there; a new group key without an entry shows as a tidied version of the key.

A new booking stays `Awaiting payment` and holds its slot for `pending_expiry_minutes` (30). The customer chooses FPX or e-wallet on the booking page and is sent to the gateway's payment page; when payment succeeds, matching starts. See **Payments** below.

## Google sign-in

Optional. Without `GOOGLE_CLIENT_ID` the Google button is simply hidden.

1. Open <https://console.cloud.google.com/>, create a project (any name).
2. **APIs & Services → OAuth consent screen**: user type External, app name Home360, your support email. While the app is in *Testing* only the test users you list can sign in; publish it before launch (the basic email/profile scopes need no Google review).
3. **Credentials → Create credentials → OAuth client ID → Web application**. Under *Authorised JavaScript origins* add `http://localhost:3000` (and your real `https://` domain later). No redirect URIs and no client secret are needed.
4. Copy the **Client ID** into `.env` as `GOOGLE_CLIENT_ID=...` and restart the server.

How it works: the browser gets a signed ID token from Google and sends it to `POST /auth/google`. The server verifies the
signature against Google's published keys, the issuer, your client id (audience) and expiry, then issues the same Home360
sessions as email login. The email always comes from the verified token, never from the browser.

- Same Google account again: always the same Home360 user, even if their Google email changes (matched on Google's stable id).
- First Google login with an email that already has an account (for example from email codes): linked to it, only when Google says the email is verified. Email codes keep working.
- New accounts still need the PDPA consent tick; nobody can become an admin this way.
- Apple sign-in is not built yet. It needs a paid Apple Developer account and a real HTTPS domain.

## Try the login flow

```
curl -X POST http://localhost:3000/auth/otp/request -H "content-type: application/json" -d "{\"email\":\"you@example.com\"}"
# read the 6-digit code from the server console, then:
curl -X POST http://localhost:3000/auth/otp/verify -H "content-type: application/json" -d "{\"email\":\"you@example.com\",\"code\":\"123456\",\"consent\":true}"
```

(`consent: true` is required the first time: PDPA. Add `"role":"provider"` to sign up as a provider.)

## API (so far)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | Liveness check |
| POST | `/auth/otp/request` | none | Email a 6-digit code (same response for any email) |
| POST | `/auth/otp/verify` | none | Exchange code for access and refresh tokens; creates the account on first use |
| POST | `/auth/google` | none | Sign in with a Google ID token (`idToken`, plus `consent` for a new account) |
| GET | `/config` | none | Public settings for the web app (Google client id, hold time, notice rules) |
| POST | `/auth/refresh` | refresh token | Rotate tokens; reusing an old token revokes every session |
| POST | `/auth/logout` | refresh token | Revoke a refresh token |
| GET | `/auth/me` | Bearer | Current user |
| GET | `/services?lang=en\|ms` | none | Active services |
| GET | `/services/:slug?lang=` | none | One service with its option groups |
| POST | `/services/:slug/estimate?lang=` | none | Instant, itemised price (see below) |
| GET | `/services/:slug/slots?date=&area=&units=` | none | Start times for a day, each flagged available or not |
| GET | `/areas` | none | Areas we serve |
| PATCH | `/me` | Bearer | Correct my name, Malaysian mobile number and language |
| GET | `/me/export` | Bearer | Download everything we hold about me as JSON (no other people's details, bank number only as last 4 digits) |
| POST | `/me/delete` | Bearer | Delete my account. Body `{"confirm":"DELETE"}`. 409 `cannot_delete` with `reasons` while a job is active or a payout is owed |
| GET/POST | `/addresses` | Bearer | Saved addresses (must be in a served area) |
| DELETE | `/addresses/:id` | Bearer | Delete an address (refused if it has bookings) |
| POST | `/bookings` | Bearer | Create a booking (starts `pending`) |
| GET | `/bookings`, `/bookings/:id` | Bearer | Your bookings, with a `rebook` payload |
| POST | `/bookings/:id/pay` | Bearer | Start paying (`method`: `fpx` or `ewallet`); returns where to send the customer |
| POST | `/payments/webhook` | gateway signature | The gateway's "payment succeeded / failed" message |
| GET/POST | `/fake-pay/:ref` | none | The pretend payment page (development only) |
| POST | `/bookings/:id/cancel` | Bearer | Cancel (see rules below); a paid booking is refunded |
| GET | `/provider/offers` | provider (approved) | Open offers: area and earnings only, `secondsLeft` for the countdown |
| POST | `/provider/offers/:id/accept` | provider (approved) | First accept wins; 409 with `offer_taken`, `offer_expired`, `booking_cancelled` or `provider_unavailable` |
| POST | `/provider/offers/:id/decline` | provider (approved) | Decline an open offer |
| GET | `/provider/jobs` | provider (approved) | Your assigned jobs; `?status=all` for history |
| POST | `/provider/jobs/:id/status` | provider (approved) | `on_the_way`, `in_progress`, `completed` |
| GET | `/provider/me`, `/provider/options` | provider | Your application (status, what is missing) and the areas and services to choose from. Open to unapproved providers |
| PUT | `/provider/profile`, `/provider/bank` | provider | Details and bank account (account number stored encrypted, only the last 4 digits come back) |
| POST/DELETE | `/provider/documents`, `/provider/documents/:id` | provider | Upload (base64 JPEG/PNG/WebP, 3 MB max) or remove ID photos; `GET /provider/documents/:id/file` shows your own |
| POST | `/provider/submit` | provider | Send the application for review (400 `application_incomplete` lists what is missing) |
| GET/PUT | `/provider/availability` | provider (approved) | Weekly working windows |
| POST/DELETE | `/provider/time-off`, `/provider/time-off/:id` | provider (approved) | Whole days off (`bookedJobsThatDay` warns about jobs already booked) |
| POST | `/provider/jobs/:id/photos` | provider (approved) | `before` (on the way or working) or `after` (working) photo; an after photo is required to finish unless `require_after_photo` is `false` |
| GET | `/bookings/:id/photos/:kind` | customer, provider or admin of that job | The photo image (404 for anyone else) |
| GET | `/provider/earnings` | provider (approved) | Available, waiting, requested, paid, and per-job lines |
| POST | `/provider/payouts/request` | provider (approved) | Withdraw everything available (needs bank details and the minimum) |
| GET | `/admin/providers?status=` | admin | Applications and providers (`pending` = submitted and waiting) |
| GET | `/admin/providers/:id` | admin | Details, documents, upcoming jobs; document images at `/admin/providers/:id/documents/:docId/file` |
| POST | `/admin/providers/:id/approve\|reject\|suspend\|reinstate` | admin | Reject and suspend need a `reason`; all are audited |
| POST | `/admin/providers/:id/documents/:docId/review` | admin | Flag a document with a note |
| GET | `/admin/payouts` | admin | Withdrawals waiting to be paid, with the bank account to transfer to |
| POST | `/admin/payouts/:providerId/pay` | admin | Record the bank transfer `reference`; jobs become `paid_out` and held payments `released` |
| POST | `/bookings/:id/review` | customer | `rating` 1-5 and optional `comment`; finished jobs only, once, within 30 days |
| POST | `/bookings/:id/dispute` | customer | `reason` (10+ chars); only on a `completed` job while the provider's payout is still on hold |
| GET/POST | `/bookings/:id/messages` | customer or assigned provider | Chat (1-1000 chars, 10 per minute); closed once the booking is paid out or cancelled |
| GET | `/chat/unread` | Bearer | Unread message counts per booking |
| POST/GET | `/recurring` | customer | Create a plan plus its first booking / list plans |
| POST | `/recurring/:id/next` | customer | Book the next visit (409 `payment_pending` until the last one is paid) |
| PATCH | `/recurring/:id` | customer | `status`: `active`, `paused` or `cancelled` |
| GET | `/provider/reviews` | provider (approved) | Your rating and reviews |
| GET | `/admin/disputes?status=open\|all` | admin | Dispute desk: reason, payment, payout, photos, message count |
| GET | `/admin/bookings/:id/messages` | admin | Read a booking's chat (read-only) |
| POST | `/admin/disputes/:id/resolve` | admin | `outcome` `refund` (optional `amountCents`, `chargeProvider`), `redo` or `reject`, plus a required `note` |
| GET | `/admin/overview?days=` | admin | Business numbers for 1-365 days (default 30): bookings, money, commission, owed to providers, new users, ratings, daily series, by service and area, busiest providers, and the to-do counts |
| GET | `/admin/reports/bookings.csv?from=&to=` | admin | One row per booking by job date (Malaysia time), up to 366 days, UTF-8 with BOM for Excel; cells starting `= + - @` are defused |
| GET | `/admin/users?q=&role=&status=&limit=&offset=` | admin | Search by email, name or phone |
| GET | `/admin/users/:id` | admin | Account details, recent bookings or jobs, suspension reason |
| POST | `/admin/users/:id/suspend` | admin | Needs a `reason`. Blocks the account at once, ends its sessions, withdraws open offers. Not for admins or yourself |
| POST | `/admin/users/:id/reinstate` | admin | Undo a suspension |
| GET | `/admin/settings` | admin | Every editable setting with value, type and limits |
| PUT | `/admin/settings/:key` | admin | Change one setting (validated with the same limits the app enforces, audited with old and new value) |
| GET | `/admin/handover` | admin | Confirmed upcoming jobs whose provider is suspended or took that day off |
| POST | `/admin/bookings/:id/rematch` | admin | Take a confirmed job from its provider and offer it to others (never the same provider) |
| GET | `/admin/audit?action=&entityId=&before=&limit=` | admin | The audit log, newest first (`action` is a prefix, e.g. `settings.`) |
| GET | `/admin/bookings?status=` | admin | All bookings |
| GET | `/admin/bookings?attention=1` | admin | Only bookings that need a provider (offered, no open offers, nobody assigned) |
| GET | `/admin/bookings/:id/candidates` | admin | Free, eligible providers, best match first |
| POST | `/admin/bookings/:id/refund` | admin | Refund all or part (`amountCents`) of a booking's payment |
| POST | `/admin/bookings/:id/refund/retry` | admin | Ask the gateway again for refunds it has not confirmed |
| POST | `/admin/bookings/:id/assign` | admin | Assign or reassign a provider |
| POST | `/admin/bookings/:id/status` | admin | Override a status (still limited by the status machine) |
| GET | `/admin/ping` | Bearer, admin | Role-guard smoke test |
| GET | `/admin/services` | admin | All services and options, including inactive |
| POST | `/admin/services` | admin | Create a service (created inactive by default) |
| PATCH | `/admin/services/:id` | admin | Edit names, price, minimum, active, sort order |
| POST | `/admin/services/:id/options` | admin | Add an option or add-on |
| PATCH | `/admin/options/:id` | admin | Edit label, price, default, active |

### Price estimate

```
POST /services/aircon-service/estimate
{ "units": 2, "options": [ { "group": "aircon_type", "code": "chemical_wash" }, { "group": "gas", "code": "gas_topup" } ] }
```

Returns line items, `subtotalCents`, `sstCents` and `totalCents` (all in sen). Rules:

- `hourly` and `per_unit`: base price × units; options marked `perUnit` are also multiplied by units, others are charged once.
- `per_size`: the chosen size option **is** the price (units must be 1); add-ons are added on top.
- `quote`: returns `{ "quoteOnly": true }`, no price.
- One option per group; groups with a default option apply it when nothing is chosen; required groups (choice or size) with no default must be chosen.
- Commission (default 20%) is calculated internally for provider earnings and is never shown to customers. SST is added on top only when `sst_enabled` is true.
- Every price is computed on the server from the catalogue. Booking (step 4) will store the result as a snapshot, so later price edits never change existing bookings.
- Every admin change is written to `audit_log`.

## Booking rules

All times are Malaysia time (UTC+8, no daylight saving). Tunable in `app_config`: `day_start`, `day_end`, `slot_interval_minutes`, `job_buffer_minutes`, `min_lead_hours`, `max_advance_days`, `pending_expiry_minutes`, `free_cancel_hours`.

- **Start times** are on an hourly grid from 08:00, and the job must finish by 20:00.
- **Notice:** at least 24 hours ahead, at most 60 days ahead.
- **Job length** = `fixed_minutes + minutes_per_unit × units` (e.g. 3 hours of cleaning = 180 min; deep cleaning = 240 min).
- **A slot is bookable** when there are more free, qualified providers than bookings already waiting for one. A provider is free when they are approved, hold every skill the service needs, cover the address's area, are inside their working hours (not on time off), and have no other job within 30 minutes of it.
- **No double-booking:** the capacity check and the insert run under a lock on the area, so two customers cannot take the last slot.
- **Unpaid bookings** hold their slot for 30 minutes, then are cancelled automatically (`payment_timeout`). This happens lazily whenever slots or bookings are read.
- **The price is always recomputed by the server** and saved with the booking, so later price changes never alter it. The snapshot also records commission and provider earnings; customers never see those.
- **Cancelling:** customers can cancel `pending`, `offered` and `confirmed` bookings; a `confirmed` one only until 12 hours before it starts. After that, an admin must do it. Refunds arrive with payments (step 6).

### Status flow

`pending → offered → confirmed → on_the_way → in_progress → completed → paid_out`, with `cancelled` and `disputed` branches. `src/bookings/status.ts` defines exactly who may make each move. Matching (step 5): when a booking's payment succeeds, it becomes `offered` and the three best free providers each get an offer. Ranking is rating rounded to the nearest half star (new providers count as 4.5), then whoever has received the fewest offers, so work is shared. The first to accept gets the job (`confirmed`) and the other offers are withdrawn. Offers expire after `offer_timeout_minutes` (15); if all three decline or expire, the booking shows under **Needs attention** and an admin assigns someone. A provider must be free for the whole job plus a 30-minute buffer. Settings `offers_per_booking` and `offer_timeout_minutes` live in the settings table.

## Payments

Everything the app needs from a payment provider is the small `PaymentGateway` interface in `src/payments/gateway.ts` (create a charge, check and parse the gateway's webhook, refund). Only a pretend gateway exists so far (`PAYMENT_GATEWAY=fake`, the default): it shows a test payment page with "Pay", "Simulate a declined payment" and "Cancel" buttons and then sends our webhook a **signed** message exactly as a real gateway would, so the code that runs in development is the code that will run with the real one. No money moves.

How a payment goes:

1. Customer picks FPX or e-wallet, `POST /bookings/:id/pay` creates a `pending` payment for the booking total (the price is always recomputed on the server) and returns the gateway's page. A new attempt replaces an unfinished one.
2. The gateway calls `POST /payments/webhook`. The signature is checked over the raw bytes; wrong or missing signature is refused (401), an unknown payment 404, a wrong amount 422 (nothing changes, and it is written to the audit log).
3. On success the payment becomes `held` (we hold the money until the provider is paid, see Providers below) and matching starts. Repeated or out-of-order messages change nothing.
4. A customer who is mid-payment when the 30-minute hold ends gets 10 more minutes. If money still arrives after the booking was released or cancelled, or the customer paid twice, the extra payment is **refunded automatically**.

Refunds: cancelling a paid booking (customer within the allowed window, or admin) refunds everything automatically; an admin can also refund part or all from `POST /admin/bookings/:id/refund`. The amount is reserved in the database first, so refunds can never add up to more than was paid, even if two happen at once. If the gateway fails, the refund stays on record as `failed` and shows in the admin list with a **Retry refund** button; the same refund id is sent on a retry so a real gateway can recognise it. SST and commission are not refunded separately: the whole booking total goes back.

**Adding a real gateway** (Billplz, Toyyibpay, Stripe, ...): write one class implementing `PaymentGateway`, add its name to `PAYMENT_GATEWAY` in `src/config.ts`, add its secrets to `.env.example`, and pick it in `createApp`. Production refuses to start with `PAYMENT_GATEWAY=fake`.

## Providers: application, work and pay

**Applying.** A visitor who clicks "Join as a service provider" signs up with `role: "provider"`. They fill in their name, Malaysian mobile number, areas, services, bank account and three photos (ID front, ID back, selfie), then send the application. Nothing they upload is public: files live in `UPLOAD_DIR` (default `./data/uploads`, **not** inside `web/`), are named by random ids, and are served only by routes that check who is asking. Uploads are checked by their actual bytes (a renamed `.txt` is refused), and the browser shrinks phone photos before sending. Bank account numbers are encrypted with `DATA_KEY` (AES-256-GCM); **back this key up**, because without it saved account numbers cannot be read again. Development falls back to `JWT_SECRET`; production requires `DATA_KEY`.

**Vetting.** Admins see submitted applications under Admin → Providers, look at the photos, and approve, reject (with a reason the provider sees, so they can fix and re-send) or later suspend/reinstate. Until approved, a provider gets 403 `provider_not_approved` on offers, jobs, calendar and earnings, and is never matched. Once approved, a provider can change areas and bio but not their vetted services or ID photos (it needs a new review); extra certificates can be added.

**Working.** Weekly hours and days off feed the same availability code as slots and matching. Marking a day off does not cancel booked jobs; the response says how many are affected so the provider can ask support to hand them over (automatic handover is part of the later admin tools). Providers add a "before" photo once on the way and an "after" photo while working; customers see both on the booking page. With `require_after_photo` (default `true`) a job cannot be finished without the after photo.

**Getting paid.** Finishing a job creates a payout line: what the customer paid before tax, our commission, and the provider's share. It becomes available `payout_hold_hours` (default 24) later, so there is time for a dispute. A provider with bank details withdraws everything available once it reaches `min_payout_cents` (default RM 50). The admin transfers the money from the company bank account, enters the transfer reference under Admin → Payouts and marks it paid; that sets the jobs to `paid_out`, releases the held customer payments and writes an audit entry. Jobs that are disputed or cancelled are held back or voided. All three settings live in the `app_config` table (`payout_hold_hours`, `min_payout_cents`, `require_after_photo`). Payouts are manual on purpose for now: automating bank transfers needs a payout provider and is a later step.

### Trying matching end to end

1. Stop the server, then `npm run db:dev-provider -- you+provider@gmail.com "Test Provider"`, and start it again with `ADMIN_EMAIL` set to your admin address (and `DEV_LOG_OTP=true` if you use fake emails).
2. Log in as a customer in one browser profile, make a booking, and pay for it (step 3).
3. Log in as admin in another profile to watch the booking and its payment.
4. Log in as the provider: the offer is on the first screen. Accept it, then step through the job buttons. The customer's booking page updates by itself.

**Services a provider offers.** While applying, a provider ticks their own services. Once approved they can only **untick** services (a service they never had needs an admin). Admins can set any provider's services under Admin → Providers → Review → Services (audited with before and after). Removing a service withdraws that provider's open offers for it; jobs they already accepted are not touched, so check Handover.

### Setting up a provider for testing

Booking times only appear when at least one approved provider is free. To test the real application flow, sign up as a provider from the home page, finish the profile, and approve yourself in Admin → Providers. For a shortcut in development:

```
npm run db:dev-provider                       # provider@example.com
npm run db:dev-provider -- second@example.com "Second Provider"   # add more capacity
```

This creates an approved provider who does every service, covers every launch area and works 08:00-20:00 daily. **Stop the dev server first**: the embedded database (PGlite) can only be opened by one process at a time. It refuses to run in production, and it never converts an existing customer or admin. See `makeProvider` in `tests/helpers.ts` for the finer-grained version used in tests.

## Customer extras: reviews, disputes, chat, repeat plans

**Reviews.** After a job is `completed` or `paid_out` the customer can rate it 1-5 with a short comment, once, within 30 days. The provider's `rating_avg` and `rating_count` are recomputed from the reviews and feed matching. Providers see their reviews (customer first name only) under Reviews. There is no moderation yet.

**Disputes.** The 24-hour payout hold is the window: while a `completed` job's payout is still `pending` and not yet available, the customer can report a problem. The booking becomes `disputed` and the provider cannot withdraw that job. An admin settles it under Admin → Disputes after looking at the photos and chat:

| Outcome | Booking | Customer | Provider payout |
|---|---|---|---|
| Full refund | `cancelled` | refunded in full | voided |
| Partial refund | back to `completed` | refunded `amountCents` | unchanged, or reduced by the refund if "charge provider" is ticked (never below zero); hold ends |
| Redo | back to `completed` | nothing | hold restarts; the admin arranges the redo off-platform for now |
| Reject | back to `completed` | nothing | available immediately |

A partial refund is paid by Home360 unless the admin charges the provider. Every settlement needs a note, is audited, and the customer sees the note.

**Chat.** One thread per booking between the customer and the assigned provider, writable while the job is confirmed, on the way, in progress, completed or disputed, and read-only afterwards. Admins read threads through the dispute desk only. Messages are plain text, limited to 10 per minute per sender. Phone numbers are not filtered yet, so customers and providers can still take bookings off the platform; add filtering or reporting before launch if that matters.

**Repeat plans.** Choosing "Repeat" on the booking page creates a plan (weekly, every 2 weeks, monthly; 2-26 visits or until cancelled) and books the first visit. No card is stored, so each visit is booked with the "Book next visit" button under Repeat plans and paid like any booking; the next one is refused while the previous visit is unpaid. With "ask my previous provider first", matching offers the new visit to the provider of the plan's last finished visit before anyone else, if they are free. Pausing or cancelling a plan does not cancel visits already booked.

## Demo data and analytics

```
npm run db:demo             # switch every service on, add about six months of dummy bookings
npm run db:demo -- --clear  # remove the dummy bookings and customers again
```

`db:demo` is development only (it refuses to run in production). It creates 40 demo customers and 3 demo providers (all `demo.*@example.com`, all services, all areas) and roughly 800 paid bookings spread over every service, with different popularity and trends (home cleaning and aircon lead, pet care and home helper grow fastest). Running it again replaces the old demo data. The dummy bookings also appear in Overview, Payouts and the CSV, so clear them before real testing. Demo providers have payouts pending, which shows up under "owed to providers".

**Analytics tab.** Pick Weeks (last 12), Months (last 12) or Quarters (last 4). It shows the most ordered service, a ranking with share of orders, booking value, change against the previous period, and a table of orders per service per period (darker = more). An *order* is a booking that was paid for; cancelled and refunded ones are shown separately; unpaid bookings that lapsed are not counted. Weeks start on Monday; everything follows Malaysia time and the day the order was placed. The newest column is still in progress, so compare it with care.

## Admin panel

Sign in as an admin and open **Admin**. Tabs: **Overview** (what needs you today, money and booking numbers for 7, 30 or 90 days, a daily chart, and a CSV download for your accountant), **Needs attention** and **All bookings** (step 4), **Handover**, **Disputes** (step 8), **Providers** and **Payouts** (step 7), **Users**, **Services** (switch services on or off, **Switch everything on**, edit prices), **Analytics** (which services get the most orders by week, month or quarter), **Settings** and **Audit log**. Admin screens are English only.

- **Money numbers.** "Paid by customers" and "refunded" come from payments created in the period; "our commission" and "owed to providers" come from the payout lines, so they are the same figures the payout screen uses. Treat them as management numbers, not accounts: SST, gateway fees and your bank statement are for your accountant.
- **Handover.** If a provider is suspended, or takes a day off after accepting, their confirmed jobs appear under Handover. "Send back to matching" removes the provider and offers the job to others, never to the same provider; "Assign by hand" uses the existing assign tool. Customers are not emailed about the change yet.
- **Suspending users.** Works at once: the account's token stops working on the next request, refresh tokens are revoked and open job offers are withdrawn. Their bookings are left alone, so check Handover afterwards. Admins cannot suspend themselves or other admins. Provider vetting (Providers tab) is separate: suspend there to stop matching without blocking login.
- **Settings.** Booking hours and notice, matching, commission and SST, payout hold and minimum, after-photo rule. Each is validated with the same limits as the code that reads it, changes take effect immediately and are audited with the old and new value. Secrets and environment variables are deliberately not editable from the web. Changing the commission affects jobs finished after the change; existing payout lines keep their amounts.
- **Audit log.** Who did what and when (settings, provider decisions, disputes, payouts, suspensions, assignments, rematches). It is append-only in the code; nothing in the app edits or deletes entries.

## Privacy, Terms and PDPA

- **Pages.** `#/terms` and `#/privacy` (linked in the footer and the login consent text), in English and Malay, from `web/js/legal-text.js`. **This is template text. Have a Malaysian lawyer review it, and have the Malay version checked by a native speaker, before launch.** Company name and support email come from `COMPANY_NAME` and `SUPPORT_EMAIL` in `.env`. When the meaning of the text changes, bump `LEGAL_VERSION` in `src/legal.ts`; each new account records the version it agreed to (`users.consent_version`).
- **Account page.** Edit name, phone and language; download my data; delete my account (type DELETE).
- **What deletion does.** Straight away: email becomes an unusable placeholder, name and phone are cleared, addresses, chat messages, review comments and booking notes are blanked, sign-ins and refresh tokens are removed, repeat plans stop, unpaid bookings are cancelled. Providers also lose their bio, bank details, documents (files deleted), areas, skills and availability. Job photos are deleted. Kept without personal details: bookings, payments, payouts and the audit log, because accounting and tax rules require them. **Ask your lawyer or accountant for the exact retention period** (the Privacy Notice says "generally seven years"; nothing deletes these records automatically yet).
- **Blocked while** a booking or job is active (offered, confirmed, on the way, in progress, disputed) or a provider payout is pending or requested. Admins cannot delete themselves here.
- The same email can sign up again afterwards as a brand-new account.
- Not in the export: identity document photos (ask support if someone requests copies), and the other party's name.

## Deploying to Vercel (online demo)

This is set up for a **demo with pretend payments**: nobody can pay real money, and the app shows a "test payments" notice. A real launch needs a real payment gateway first (not built yet) and a lawyer's review of the Terms and Privacy text.

Vercel has no permanent disk and no always-running process, so the demo needs four things outside Vercel: a **Postgres database**, a **private file bucket**, an **email (SMTP) account** for login codes, and a few **environment variables**.

1. **Put the code on GitHub.** `.env`, `data/`, `dist/` and `node_modules/` are already git-ignored. Run `npm install` first (it adds the S3 library and updates `package-lock.json`) and commit that.
2. **Database.** In Vercel: Storage → Marketplace → **Neon** (Postgres), region **Singapore**, or create one at neon.tech. Copy the *pooled* connection string into `DATABASE_URL`. The app creates its own tables on first start.
3. **File bucket.** Create a **private** bucket (AWS S3 in `ap-southeast-1` with "Block all public access" on, or Cloudflare R2) and a key that can read, write and delete in that bucket only. Photos and ID documents are never public: the app fetches them and shows them only to people allowed to see them.
4. **Email.** Any SMTP account works (Brevo, Resend, Gmail with an app password). Without it nobody can log in, because login codes are emailed.
5. **Import the repo in Vercel** (Add New → Project). Leave the framework as "Other"; `vercel.json` already sets the build, the Singapore region and a daily cron. Add these environment variables, then Deploy:

| Variable | Value |
|---|---|
| `JWT_SECRET`, `OTP_SECRET` | two different random strings of 32+ characters |
| `DATA_KEY` | another random string of 32+ characters. **Never change it later**: it encrypts providers' bank account numbers |
| `DATABASE_URL` | the Neon connection string |
| `STORAGE` | `s3` |
| `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | from your bucket (`S3_ENDPOINT` only for R2) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | from your email service |
| `ALLOW_FAKE_PAYMENTS` | `true` (demo only) |
| `CRON_SECRET` | a random string of 16+ characters |
| `ADMIN_EMAIL` | your email: becomes the admin account |
| `COMPANY_NAME`, `SUPPORT_EMAIL` | shown on the Terms and Privacy pages |

   Random strings: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. `GOOGLE_CLIENT_ID` is optional; if you use it, add your Vercel address under the OAuth client's authorised JavaScript origins.
6. **Add the starting data** (services, areas and your admin). From your own computer, pointing at the online database (PowerShell):
```
$env:DATABASE_URL="postgres://...neon..."; $env:ADMIN_EMAIL="you@gmail.com"; npm run db:seed
$env:DATABASE_URL="postgres://...neon..."; npm run db:demo   # optional: dummy bookings for the analytics tab
```
7. Open your Vercel address and log in with `ADMIN_EMAIL`.

**Limits to know about**
- **Hobby plan:** Vercel's free plan is for non-commercial use, and cron runs **once a day**. The app also releases unpaid slots whenever someone checks availability, so a demo works, but for a business use Pro and change the schedule in `vercel.json` to `"* * * * *"`.
- **Uploads are limited to about 4.5 MB** per request on Vercel. The web app shrinks photos before sending, so this is only a problem for other clients.
- **Rate limits are per running instance** (in memory), so they are weaker than on a single server.
- **Cold starts:** the first request after a quiet period takes a second or two longer.
- **Pretend payments stay on.** The demo shows a "test payments" notice; nothing real is charged.
- Prefer a normal always-on server (Railway, Render, Fly.io or a VPS)? The app runs there unchanged with `npm run build` and `npm start`, set `STORAGE=disk` with a persistent volume, and no cron is needed.

## Security decisions

- OTP codes are 6 digits, expire in 10 minutes, allow 5 wrong attempts, are single-use, and are stored only as an HMAC.
- Limits: 60-second resend cooldown, 5 codes per email per hour, plus a per-IP rate limit.
- Access tokens last 15 minutes. Refresh tokens last 30 days, are stored hashed, and rotate on every use.
- Roles are read from the database on every request, so suspending a user or changing a role takes effect immediately.
- Nobody can self-register as admin. Admins are created by `ADMIN_EMAIL` in the seed, or by editing the database.
- Web app: strict Content-Security-Policy (no inline scripts or styles; only Google's sign-in script is allowed from outside), all server text is inserted as text, never HTML. The refresh token is kept in `localStorage` so a reload keeps you logged in; the 15-minute access token stays in memory. Moving the refresh token to an httpOnly cookie is a later hardening step (it needs CSRF protection).
- The browser refreshes tokens one request at a time, because the server treats a reused refresh token as theft and logs out every device.
- Google tokens: RS256 signature, issuer, audience and expiry are all checked here (`src/auth/google.ts`); an unverified Google email is refused.
- Identity photos and job photos are private: never served as static files, fetched by the web app with the login token, `no-store` caching, and 404 (not 403) for anyone who is not allowed.
- Email OTP is login only. Once real money is involved, consider also requiring phone verification for providers.

## Environment variables

See `.env.example`; every variable is documented there. `JWT_SECRET` and `OTP_SECRET` (32+ characters) are required. In production `DATABASE_URL` and `SMTP_HOST` are also required, and the app refuses to start without them.

## Data model

All tables are in `migrations/001_init.sql`. Money is stored as integer sen (RM 1.00 = 100). Main groups:

- **Identity:** `users`, `otp_codes`, `refresh_tokens`, `user_identities` (Google/Apple links, migration 003)
- **Geography:** `areas` (Kuching, Sibu, Petaling Jaya, Subang, Kepong), `addresses`
- **Providers:** `providers`, `provider_documents`, `provider_areas`, `provider_availability`, `skills`, `provider_skills`
- **Catalogue:** `services`, `service_options`, `service_skills`
- **Bookings:** `bookings`, `booking_items`, `job_offers`, `booking_assignments`, `recurring_plans`
- **Money:** `payments`, `payouts`
- **Trust:** `messages`, `reviews`, `disputes`
- **Admin:** `app_config` (commission, SST, timeouts), `audit_log`

## Adding a new service (no schema change)

**Services already seeded but switched off:** grass cutting, glass cleaning, post-renovation cleaning, move-in/move-out cleaning, carpet and curtain cleaning, window grille and kitchen exhaust cleaning, bed linen and curtain change, fridge and oven cleaning, gardening and plant care, dog walking and pet sitting, and home helper (elderly and post-natal support). All prices are placeholders. To launch one: check its prices and switch it on under **Admin → Services**, and tick its service for some providers under **Admin → Providers → Review → Services**. Pet care and home helper have their own skills (`pet`, `care`), so those providers need separate vetting; for the home helper consider extra checks (references, police clearance) before you switch it on.

**Without code:** log in as admin and call `POST /admin/services`, then `POST /admin/services/:id/options` for its add-ons. Switching on and prices are in the Services tab (or `PATCH /admin/services/:id` with `{ "active": true }`). There is no screen yet to create a brand-new service or add options.

**Or via the seed:**

1. Add an entry to `SERVICES` in `src/db/seed.ts`: slug, English and Malay names, pricing model (`hourly`, `per_unit`, `per_size` or `quote`), base price in sen, options and required skill codes.
2. If it needs a new skill, add it to `SKILLS`.
3. Run `npm run db:seed`.
4. Set `active = true` (the grass-cutting and glass-cleaning rows are seeded inactive for this reason).

Re-running the seed never overwrites prices or the `active` flag you changed later.

## Placeholders to change before launch

- **All prices in `seed.ts` are placeholders**, not researched market rates.
- `sst_enabled` is `false`. Ask your accountant whether SST applies to your services before turning it on.
- Commission defaults to 20% (`commission_rate` in `app_config`).
- Set `COMPANY_NAME` and `SUPPORT_EMAIL`, add your SSM number and registered address to `web/js/legal-text.js`, and get the Terms and Privacy text reviewed by a lawyer.
- If SST is switched on, the unit prices on the home page are shown before SST; the booking summary always shows the SST-inclusive total.
- The "Booking received" message mentions that an admin confirms bookings until payments exist. Reword it when step 6 lands.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start with auto-reload |
| `npm start` | Start once |
| `npm test` | Run tests |
| `npm run typecheck` | TypeScript check |
| `npm run build` | Compile to `dist/` |
| `npm run db:migrate` | Apply pending migrations only |
| `npm run db:seed` | Migrate, then seed |
| `npm run db:dev-provider` | Development only: add an approved test provider so slots appear |

## Next steps

- Email or push notifications for new chat messages, application decisions and payouts once a mailer template set exists.
- A real payment gateway, and automated provider payouts through a payout provider.

Also still to do: Apple sign-in, an automatic clean-up of old financial records once the retention period has passed.



## Demo logins (no email needed)

Set `DEMO_MODE=true` (and optionally `DEMO_PASSWORD`, default `demo1234`). The login page then shows a username/password form with three accounts, created on first use:

| Username | Role | What it sees |
|---|---|---|
| `admin` | Super admin | Admin panel: bookings, providers, services, analytics, settings |
| `vendor` | Provider | Approved vendor covering every area and service, available 08:00-20:00 |
| `user` | Customer | Customer with one saved address |

Emailed codes and Google sign-in are hidden while it is on. In production it needs `ALLOW_FAKE_PAYMENTS=true` and no SMTP. Turn it off (`DEMO_MODE=false`) for anything real.

### Vercel demo without a file bucket or SMTP

For a small labelled demo you only need Postgres (Neon) plus env vars: set `DEMO_MODE=true`, `ALLOW_FAKE_PAYMENTS=true` and `STORAGE=db` (photos and ID documents are kept in the database table `stored_files`, so no S3/R2 bucket). Add `JWT_SECRET`, `OTP_SECRET`, `DATA_KEY`, `CRON_SECRET`, `ADMIN_EMAIL`, `COMPANY_NAME`, `SUPPORT_EMAIL`. In production `STORAGE=db` is refused unless `DEMO_MODE=true`; use `STORAGE=s3` for real use.
