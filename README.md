# ترويقة — Tarweeqa

طلب فطار مجمّع للمجموعة: نختار المطعم، كل واحد يطلب ويعرف حسابه، الإيصال يحدّث الأسعار، والفلوس تتلم.
A group breakfast-ordering web app: pick the restaurant, everyone orders and sees their share, the Talabat receipt updates prices, and payments are tracked.

## How it runs
- **Website:** static files in this repo, served by GitHub Pages. Open it on a phone and "Add to Home screen".
- **Database:** Supabase project `tarweeqa`. All reads/writes go through the functions in `supabase/schema.sql` and `supabase/migrations/`; tables are closed to the public.
- **Accounts:** sign in with phone number + PIN (4–6 digits) on any device. 5 wrong tries lock the number for 15 minutes. A forgotten PIN is reset by the admin with a one-time code (valid 24h).
- **How ordering works:** the group is fixed (same people every day). The admin starts today's order with one tap on a restaurant (home screen), and can switch the restaurant of an open order (⇄ Change restaurant). Members only see their group's open order; with no group order they see the available restaurants. A member can leave the group order and **order by himself** (a solo order only he and the admin see).
- **Reminder:** while someone has an open order they haven't confirmed, a bar stays on every screen until they press **I'm done** (or "not eating today").
- **Test account:** phone `123456`, PIN `1234` — a fake member in the "تجربة" test group, for trying the app as a second person.
- **Admin page** (`?admin`, only the site admin): people (one-time codes, sign out of all devices, remove from a group, rename), restaurants and menus, groups and invite links, and who still owes money. Members can only order from the menu they are sent and see their own orders and invoices (Profile → My orders & invoices).
- **Menu / receipt reading:** on-device text recognition (`ocr/`, Tesseract.js, Arabic + English). Nothing is uploaded anywhere.
- **Restaurant places (admins):** each restaurant is picked from Google Maps (`places.js`), so it is a real place with a known location. The group's delivery point (the office) is set on the Restaurants screen; distances are measured from it on the phone, and restaurants beyond their delivery range are hidden when starting an order. Needs `googleMapsKey` in `config.js` (Maps JavaScript API + Places API (New)); without it the search is off and everything else works.
- **Settings:** `config.js` (database address and public key, deadlines, currency).

## Files
| File | What it does |
| --- | --- |
| `index.html`, `styles.css` | Page and design |
| `app.js` | Screens and actions |
| `core.js` | Bill split, estimates, balances, menu and receipt reading (pure functions) |
| `store.js` | Data: demo mode, Supabase (live), Firebase (unused alternative) |
| `places.js` | Google Maps search for restaurants and the delivery point (admins only) |
| `i18n.js` | Arabic and English text |
| `supabase/schema.sql` | Database tables and the rules each function enforces |
| `sw.js`, `manifest.webmanifest`, `icons/` | Install as an app, offline shell |

If `supabase` in `config.js` is removed, the app runs as a demo with sample data stored only in the browser.
