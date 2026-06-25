# Juel Haus — QA Test Checklist

Run through this before every production deploy. Test on both desktop and mobile (Safari iOS + Chrome Android) — guests scan QR codes on phones.

Use a real test email you control (e.g. `barrykeiththomas+test1@gmail.com` — Gmail ignores `+tags`) so you can verify transactional emails land.

---

## 1. Auth (`index.html`, `auth.js`)

- [ ] Register new account — firstName, lastName, email, mobile, password
- [ ] Verification email arrives (Resend, branded, correct footer)
- [ ] Login blocked until email verified (if enforced) / checkout blocked until verified
- [ ] Resend verification email works (`resendVerification`)
- [ ] Login with correct credentials succeeds
- [ ] Login with wrong password fails with generic error (no enumeration leak)
- [ ] 5 failed login attempts → account locked for 15 min, correct message shown
- [ ] "Remember me" checked → session persists after browser restart (30 days)
- [ ] "Remember me" unchecked → session does not persist after browser restart
- [ ] Idle for 60+ min → session times out, redirected/prompted to re-auth
- [ ] Forgot password → reset email arrives → new password works
- [ ] Logout clears session and redirects correctly
- [ ] Admin account redirected to `/admin.html` automatically on login

## 2. Storefront (`index.html`, `app.js`, `products.js`)

- [ ] Welcome Pack cards load from Firestore `welcomePacks` (no longer a static array) — skeleton placeholders show briefly, then real cards render with correct name/price/tagline/features/image
- [ ] If `welcomePacks` is empty, public site shows "Welcome packs coming soon" message instead of a blank grid
- [ ] Packs with `isActive: false` do NOT appear on the public storefront
- [ ] Packs render in `sortOrder` order
- [ ] Add to cart → cart icon count updates
- [ ] Cart persists on page refresh (localStorage `bh_cart`)
- [ ] Cart drawer opens/closes, shows correct items + line totals
- [ ] Remove item from cart updates total
- [ ] "Get Started" — logged out → shows auth modal → after login, scrolls to Welcome Packs
- [ ] "Get Started" — logged in → scrolls straight to Welcome Packs
- [ ] "Proceed to Checkout" while logged out → auth modal → after login/register, redirects into checkout (`checkout_pending` flow)
- [ ] Chat widget opens, decision-tree flows work, submitting creates a `supportTickets` doc
- [ ] "Book a Demo" modal — submitting shows success message, modal auto-closes after ~2.5s, and reopening it later does NOT still show the stale success/error state

## 3. Checkout (`checkout.html`, `checkout.js`) — repeat for 1 item and for 2+ items in cart

For each cart item:
- [ ] **Property & guest**: address autocomplete (Nominatim) returns ZA results; guest name, check-in/out dates, Wi-Fi SSID+password, host name + WhatsApp number all save
- [ ] **Branding**: business name, logo font dropdown, accent colour picker all apply and persist into preview
- [ ] **Mode selection**: "use saved property" pulls in a property from My Properties correctly; "new property" starts blank
- [ ] **House rules**: 3 defaults pre-loaded, can add/remove/edit
- [ ] **Restaurants**: auto-populated via Nominatim/Overpass near the property address; manual add works
- [ ] **Activities**: same as restaurants
- [ ] **Review & confirm** step shows all entered data correctly before payment

Then:
- [ ] Delivery fee calculates via the `getDeliveryRate` Cloud Function (proxies TCG ShipLogic server-side — TCG API key never reaches the browser); haversine fallback works if the function returns `{rate: null}`
- [ ] **Personalise Your Pack** (premium upgrades) — for a pack with `upgrades` enabled (whisky/wine/champagne), modal appears once per qualifying cart item right after clicking "Proceed to Payment" on Delivery Confirmation, before Billing
  - [ ] Each enabled category shows "Keep {defaultLabel} (included)" plus all configured paid options with name/description/+price/image
  - [ ] Selecting an option updates the running total in the modal summary live
  - [ ] "Continue" saves the selection, advances to the next item in the queue (or to Save Configuration if it's the last)
  - [ ] "Skip upgrades" keeps base price and still advances the queue
  - [ ] Going back into the modal for the same checkout session pre-fills the previous selection (doesn't reset to default)
  - [ ] Cart items with no enabled upgrade categories are skipped — modal never appears for them
  - [ ] Selected upgrade(s) show as "+ {name} +R{price}" line(s) under the pack in the Delivery Confirmation summary and on Review & Confirm
  - [ ] Final cart/order total = `basePrice + upgradeTotal` per item, summed correctly into PayFast `amount`
- [ ] Billing details step — Nominatim autocomplete, saves to `customers/{uid}`
- [ ] PayFast redirect is now built server-side by the `createPayFastPayment` Cloud Function (merchant passphrase/signature never appear in browser devtools/network tab — only the final signed `params` array does)
- [ ] `createPayFastPayment` rejects with `permission-denied` if called for an order that isn't the logged-in user's
- [ ] `createPayFastPayment` rejects with `failed-precondition` if called again for an order that's already been paid (`order.paidAt` set) — prevents double-charge via back button
- [ ] PayFast sandbox payment completes successfully → redirected to confirmation
- [ ] PayFast sandbox payment cancelled/failed → user returned to checkout, cart not lost
- [ ] Order appears in Firestore `orders` with correct `status: "pending"`, all item fields populated, and `basePrice`/`upgrades`/`upgradeTotal` present on items that had upgrades
- [ ] Order confirmation email sent to customer (Resend) — copy now points to the **account page support chat**, not "reply to this email or WhatsApp"
- [ ] QR codes (Wi-Fi + Welcome) generated and stored as base64 in the order — **not shown to customer**, only visible in admin
- [ ] TCG waybill creation — `delivery_contact.email` is sent **empty** (intentional: prevents ShipLogic/Courier Guy from sending the customer its own tracking emails outside Juel Haus's branded status emails). Confirm no stray courier email reaches the test customer inbox.

## 4. My Account (`account.html`)

- [ ] **My Orders** — only shows the logged-in user's own orders
- [ ] Order status badges render correctly for both new and legacy status values
- [ ] Cancel order works for `pending` orders only; button hidden/disabled for other statuses
- [ ] Cancelling triggers `cancelOrder` function and updates Firestore + UI
- [ ] **My Profile** — edit firstName/lastName/mobile/billing address, save persists to `customers/{uid}`
- [ ] **My Properties** — add new property, all fields save (incl. WhatsApp country code dropdown — full ~190-country list)
- [ ] Edit existing property — changes save correctly
- [ ] Delete property works
- [ ] Saved property is selectable in checkout "use saved property" mode
- [ ] "Need help?" button opens chat widget pre-scoped to `properties` topic
- [ ] Welcome banner shows on `?registered=true` and fades after 5s
- [ ] **My Orders** — "Track Order →" link goes to `/track?waybill={waybillNumber}` once a waybill exists, otherwise `/track?id={orderId}`; the old inline waybill link/text under the order row has been removed (tracking now happens only via `track.html`)

## 5. Admin Dashboard (`admin.html`)

- [ ] Non-admin user cannot access `/admin.html` (redirected or blocked)
- [ ] Admin user loads dashboard, stats cards show correct totals (total/assembling/in-transit/delivered)

### 5a. Orders tab

- [ ] Orders table loads via `getAdminOrders`, filters/search work (search matches customer name/email/mobile, waybill, property, guest name)
- [ ] **Delivery Date column + urgency colour code**: orders in `pending`/`assembling`/`ready_for_collection` show a coloured left-border + dot — red (due today or overdue), amber (due within 3 days), green (4+ days out); orders past those statuses show no urgency colour regardless of date
- [ ] Orders table is sorted soonest-delivery-first (red at top); orders with no delivery date set yet sort to the bottom
- [ ] Cancelled orders still render with the dimmed `row-cancelled` styling alongside the urgency border where applicable
- [ ] **Export CSV** button downloads `juelhaus-orders-{date}.csv` with all orders (date, customer, email, mobile, property, guest, subtotal, delivery, total, waybill, status) — opens correctly in Excel/Sheets, no broken quoting on names/addresses containing commas
- [ ] Order detail modal opens, shows per-item QR codes (Wi-Fi + Welcome) correctly
- [ ] Update order status via the normal forward-progression buttons — triggers `onOrderStatusChanged` → customer receives status email, and the public `orderTracking/{id}` doc's `statusHistory` gets a new entry
- [ ] **Force/Override status buttons** ("Force Mark as In Transit/Delivered/Completed") — require the confirmation panel to be opened and confirmed before applying; cancelling the confirm panel leaves status unchanged
- [ ] Cancel order from admin — confirm panel required; triggers `cancelOrder` Cloud Function, customer notified by email, status becomes `cancelled`
- [ ] Enter/edit waybill number, tracking link renders correctly
- [ ] **Inline item edit** (Wi-Fi security type/SSID/password/hidden toggle, welcome message, logo font) saves correctly back to Firestore via `saveItemEdit`
- [ ] **Welcome message translate dropdown** — selecting a language calls `translateWelcomeMessage`, replaces the message textarea with the translated text (truncated to 200 chars), and re-selecting the original/another language re-translates from the original English source (not from an already-translated string); a failed translation call shows the inline error message instead of clearing the field
- [ ] **Print Package section** (per item):
  - [ ] "Download Print Package" produces a `.zip` (via JSZip) containing `qr-print-sheet.png` plus either `branding-logo.{png|svg}` + `branding-preview.html` (logo branding) or `branding-text.html` (text branding) — button shows loading → success/error state correctly
  - [ ] QR sheet preview opens in a new tab and matches the downloaded sheet (Wi-Fi left, Welcome right, 300 DPI dimensions noted in the UI)
  - [ ] Branding sheet preview opens in a new tab and matches the logo or text branding actually configured for that item
  - [ ] "Packaging company instructions" expand/collapse toggle works; "Copy" button copies the instructions text to clipboard (and falls back correctly on browsers without clipboard API)

### 5b. Welcome Packs tab

- [ ] Opening it for the first time on an empty `welcomePacks` collection auto-seeds the original 6 packs (same IDs/prices/descriptions) so the storefront isn't blank
- [ ] Add new pack — name, tagline, price, price label override, badge, description, dynamic features list, image (upload to Storage **or** paste URL) with live preview, active toggle, sort order all save correctly
- [ ] Image upload is client-side compressed/resized (max 1200px, targets ~95KB) before upload regardless of source file size (up to the 4MB raw cap); rejects non jpg/png/webp and files >4MB before compression is attempted
- [ ] Edit existing pack — changes save and reflect on the public storefront immediately (no redeploy needed)
- [ ] Reorder packs via up/down arrows — `sortOrder` updates and storefront order changes to match
- [ ] Toggle a pack inactive — disappears from public storefront grid immediately; toggle back active — reappears
- [ ] Delete pack — confirmation modal required; pack removed from Firestore, old Storage image deleted, and storefront updates
- [ ] **Premium Upgrades sub-section** (within pack add/edit form) — for each of whisky/wine/champagne: enable toggle, default-label field, and add/edit/remove upgrade options (name, description, +price, optional image) all save correctly; save is blocked if an option is missing name/description/price
- [ ] Order detail modal — for an order containing upgrades, shows base price + each chosen upgrade + item total correctly

### 5c. Audit Log tab

- [ ] Dedicated **Audit Log** tab (separate from User Management) loads and lists recent entries with time/action/target/performed-by columns
- [ ] An admin grant/revoke action (5d) appears here promptly after the action

### 5d. User Management tab

- [ ] Grant admin to a test account via `manageAdminClaims`, confirm claim appears after token refresh
- [ ] Revoke admin from that test account, confirm access removed
- [ ] Audit log entry created for each grant/revoke action (verify in the Audit Log tab, 5c)

### 5e. Support Tickets tab

- [ ] List shows urgency flag correctly, opens ticket detail with full transcript
- [ ] Reply to a ticket — email sent from `no-reply@juelhaus.co.za` with `reply_to: admin@juelhaus.co.za`
- [ ] Resolve ticket updates status and removes/greys it from open list

## 6. Welcome Page (`welcome.html`) — guest-facing, no auth

- [ ] Scan/open Welcome QR from a completed order → correct guest's page loads at `/welcome/{guestName}`
- [ ] Brand logo, accent colour, and font match what host configured at checkout
- [ ] Wi-Fi details display correctly; "join network" QR scan connects (if testing on a phone near a real AP, optional)
- [ ] House rules, restaurants, and activities all display
- [ ] Host name + WhatsApp link opens chat correctly
- [ ] **Collection address (56 Robberg Road) is NEVER shown anywhere on this page**
- [ ] Page works correctly with no login, in a private/incognito window

## 7. Order Tracking (`track.html`)

- [ ] Enter valid order ID or email → correct status shown
- [ ] Enter invalid order ID/email → graceful "not found" message, no stack trace/error leak
- [ ] No sensitive data (collection address, customer billing, QR codes) exposed on this public page
- [ ] Visiting `/track?id={orderId}` or `/track?waybill={waybillNumber}` directly (e.g. from the My Orders link) auto-fills the input and runs the search on page load

## 8. Webhooks / Cloud Functions (best tested via logs, not UI)

- [ ] `payfastNotify` — simulate ITN call in sandbox, confirm order status updates correctly
- [ ] **New order alert email now goes to `orders@juelhaus.co.za`** (changed from `admin@juelhaus.co.za` — confirm in `payfastNotify` logs / inbox, not the admin inbox)
- [ ] `createPayFastPayment` — call directly as a non-owner / for an already-paid order and confirm it throws (`permission-denied` / `failed-precondition`) rather than returning a usable signed redirect
- [ ] `getDeliveryRate` — call with a valid ZA postal code, confirm it returns `{rate: <number>}`; call with TCG unreachable (or invalid postal code) and confirm it degrades to `{rate: null}` rather than throwing
- [ ] `tcgWebhook` — simulate courier status update, confirm waybill/status updates on the order
- [ ] `dailySummary` scheduled function — check logs for successful run + email received by admin

## 9. Security: server-side credentials (regression check)

PayFast and TCG credentials were moved out of `public/js/config.js` entirely (no longer hardcoded
client-side, even for sandbox) — they now live only in `functions/.env`, read via `cfg()` in
`functions/index.js`. Re-verify this hasn't regressed on every release:

- [ ] View page source / devtools on `checkout.html` — no PayFast merchant ID, merchant key, or passphrase, and no TCG API key, anywhere in shipped JS (`config.js` should only contain the display-only `ENV` sandbox-banner flag and Resend **from-addresses**, never the Resend API key)
- [ ] `public/checkout.html` no longer loads `/md5.min.js` (client-side PayFast signing was removed along with the client-held passphrase — signing now happens in `createPayFastPayment`)
- [ ] Network tab during checkout: the PayFast form `action`/params are received from the `createPayFastPayment` callable response, not constructed from local config
- [ ] CSP `img-src` includes `blob:` (needed for the Welcome Pack image-upload preview in admin) — confirm this didn't loosen anything else in `firebase.json`'s CSP header

## 10. Cross-cutting

- [ ] Test full flow on a real mobile device (iOS Safari + Android Chrome), not just responsive devtools
- [ ] No console errors on any page (storefront, checkout, account, admin, welcome, track)
- [ ] All emails sent during this run have the correct footer: `© 2026 Juel Haus (Pty) Ltd · Plettenberg Bay, South Africa · www.juelhaus.co.za`
- [ ] Customer-facing email copy says to use the **account page support chat** — not "reply to this email" or a WhatsApp number (changed in order-confirmation and support-ticket-reply emails; nobody monitors the `no-reply@` inbox)
- [ ] No reference to `baylinhaus-c9d41` anywhere (deprecated project)
- [ ] Firestore rules still block unauthenticated reads/writes to `customers`, `orders`, `adminUsers`, `adminAuditLog`
- [ ] Firestore rules allow public read but admin-only write on `welcomePacks`; Storage rules allow public read but admin-only write (≤2MB, jpg/png/webp) on `welcomePacks/{packId}/...`

## 11. Email Infrastructure — DNS & Resend Setup

All transactional email is sent via the **Resend** API (`resend.api_key` in `functions/.env`,
`resendClient()` in `functions/index.js`) from three `@juelhaus.co.za` identities — see
`EMAIL_ADDRESSES.md` for the full per-address breakdown:

| Address | Used as |
|---|---|
| `no-reply@juelhaus.co.za` | `from` — all customer transactional email (verify, reset, order status/confirmation, welcome) |
| `orders@juelhaus.co.za` | `from` on the daily-summary digest; `to` for new-order alerts (`payfastNotify`); TCG collection-contact email |
| `admin@juelhaus.co.za` | `to` for registrations, cancellations, support tickets, demo requests, daily summary; `reply_to` on support-ticket replies |

None of this will deliver (or will land in spam) unless the **sending domain itself** is verified —
this is infrastructure, not application code, so it isn't something a code scan catches:

- [ ] `juelhaus.co.za` is added and **verified** as a sending domain in the Resend dashboard (resend.com → Domains)
- [ ] The DNS records Resend issues for that domain (SPF/TXT, DKIM/CNAME, and a return-path/MX record if Resend requires one) are added at whichever registrar/DNS host manages `juelhaus.co.za` (e.g. **domains.co.za**, or wherever the domain is actually parked — confirm this hasn't moved since `juelhaus.co.za` DNS was last touched for the custom-domain Firebase Hosting setup)
- [ ] A DMARC TXT record exists for the domain (even a basic `p=none; rua=mailto:admin@juelhaus.co.za` policy) — large inboxes (Gmail/Yahoo) increasingly soft-reject bulk mail from domains with no DMARC record at all
- [ ] Confirm the Firebase Hosting custom-domain DNS records (for `juelhaus.co.za` → Hosting) and the Resend email DNS records coexist on the same zone without conflicts (e.g. no SPF record being overwritten/duplicated — a domain can only have **one** SPF TXT record, so if a host/registrar default SPF exists it must be merged, not duplicated, with Resend's)
- [ ] Send one live test email per identity (`no-reply@`, `orders@`, `admin@`) to an external address (Gmail/Outlook) and confirm: lands in Inbox not Spam, "from" displays correctly, and the receiving client shows SPF/DKIM/DMARC all passing (View Original / Show Original headers)
- [ ] Resend dashboard → Logs shows no bounce/complaint spike after a deploy that touches email-sending code
