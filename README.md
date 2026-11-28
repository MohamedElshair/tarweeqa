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
- **Managing a group (admins):** on the Group screen — ✎ next to the name renames the group; ✎ on a member edits their name (and the phone of someone without an account) or removes them; the invite link can be opened directly (↗ Open), copied, or sent on WhatsApp. **Add someone** with a name and number: WhatsApp opens straight on that person's chat with the group link ready to send; when they open it and sign in with the same number, they replace the "invited" row (no duplicate). The site admin can also open any group's management page from Admin → Groups.
- **Group order wording:** what used to be called a "group" (المجموعة) is now called a "group order" (الطلب الجماعي) everywhere on screen.
- **The manager doesn't have to order:** on the group order screen, untick **I'm ordering with them too** (also offered when creating one). The admin then manages only: left out of the people list, reminders and bills, and can still order on someone's behalf.
- **Delete a group order (site admin):** at the bottom of its screen, or from Admin → Group orders. It disappears for everyone, its link stops working and its daily order stops — but its restaurants, past orders, invoices and money owed are kept, and Admin → Group orders → Deleted can bring it back.
- **Daily automatic order (admins):** Group → ⏰ Daily automatic order: pick the days, the opening and closing time (Egypt time), and the restaurant (a fixed one, or the same as the last order). The database opens the group's order by itself every minute it checks (`tq_schedule_run`, run by `pg_cron`), with the admin's host settings, and it closes by itself at the closing time. If the admin already opened an order that day, the schedule doesn't open another.
- **Same as last time?** When someone opens an order with an empty basket, the app asks whether they want their last order again (same restaurant, or another restaurant whose menu has all the same items), showing the items and prices: **Yes** adds them and confirms, **Edit it** adds them to change, **No** starts fresh.
- **Old balance when ordering:** money left in the person's wallet is shown at the top ("will be taken off today's bill"). An unpaid share from an earlier order asks: **Pay it now** (InstaPay / wallet details and "I paid") or **Add it to today's bill**.
- **Item options (admins):** in a restaurant's page, **Item options** holds groups like "Eggs: fried / boiled / omelette +2" or "Extras". Each group can be required or optional, pick-one or pick-several (with a maximum), and a choice can add to the price. Link a group to items from the item's editor, or to many items at once with **Select several → Link option…**. When a member taps an item that has options, a sheet asks for the choices (and an optional note); the same item with different choices becomes separate lines, and the combined order shows them as e.g. `3 × فول بالبيض (مقلي)`. A receipt teaches the menu the item's own price, without the options' extra.
- **Spelling of item names:** every item name is corrected automatically before it is saved and when it is shown (menus, typed-in items, receipts, option choices): «سندويتش» → «ساندويتش», «معصر» → «معصفر», «جبنه» → «جبنة». People's and restaurants' names are never changed. The list of fixes is `SPELL` in `core.js` — add a new one as one line `'wrong': 'right'`.
- **Importing a menu — three ways, in order (admins):** a restaurant has three optional links: **Talabat**, the **restaurant link** and the **menu link**. **🔗 Get the items from the links** tries the menu link, then Talabat, then the restaurant link: the Supabase function `menu-fetch` (`supabase/functions/menu-fetch/`, admins only, public web addresses only) opens that one page and returns the menu it finds in the page's data (Talabat / Next.js data, schema.org menus), or the page text, or menu pictures that the phone then reads. If no link gives a menu, the screen points to the 2nd way, **menu screenshots**; if those can't be read either, it opens the 3rd way, **paste the menu** copied from the page. Items from any way are highlighted in yellow to review.
- **Menu / receipt reading:** on-device text recognition (`ocr/`, Tesseract.js, Arabic + English). Screenshots are read on the phone; only the receipt/menu pictures you save are stored with the restaurant.
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
