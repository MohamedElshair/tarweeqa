# ترويقة — Tarweeqa

طلب فطار مجمّع للمجموعة: نختار المطعم، كل واحد يطلب ويعرف حسابه، الإيصال يحدّث الأسعار، والفلوس تتلم.
A group breakfast-ordering web app: pick the restaurant, everyone orders and sees their share, the Talabat receipt updates prices, and payments are tracked.

## How it runs
- **Website:** static files in this repo, served by GitHub Pages. Open it on a phone and "Add to Home screen".
- **Database:** Supabase project `tarweeqa`. All reads/writes go through the functions in `supabase/schema.sql`; tables are closed to the public. Each browser keeps a secret device token (no sign-up).
- **Menu / receipt reading:** on-device text recognition (`ocr/`, Tesseract.js, Arabic + English). Nothing is uploaded anywhere.
- **Settings:** `config.js` (database address and public key, deadlines, currency).

## Files
| File | What it does |
| --- | --- |
| `index.html`, `styles.css` | Page and design |
| `app.js` | Screens and actions |
| `core.js` | Bill split, estimates, balances, menu and receipt reading (pure functions) |
| `store.js` | Data: demo mode, Supabase (live), Firebase (unused alternative) |
| `i18n.js` | Arabic and English text |
| `supabase/schema.sql` | Database tables and the rules each function enforces |
| `sw.js`, `manifest.webmanifest`, `icons/` | Install as an app, offline shell |

If `supabase` in `config.js` is removed, the app runs as a demo with sample data stored only in the browser.
