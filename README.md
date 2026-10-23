# Cohort Builder (v0.1)

Build customer segments from historical purchases and push them to CleverTap as custom lists. Nobody handles a raw email or phone list.

```
Excel upload ─┐
              ├─► filters + preview ─► approval (locks audience) ─► push worker ─► CleverTap custom list
Power BI API ─┘   (counts only)          (encrypted snapshot)        (decrypts in memory)
```

## Run it

Needs Node.js 20+.

```bash
npm run setup        # installs packages, creates .env with encryption keys, writes sample files
npm run dev          # API on :4000 + web app on http://localhost:5173
```

There are two windows in the same app, with no tab or link between them:

| Window | Address | Who |
|---|---|---|
| **Marketing** | http://localhost:5173/ | Builds cohorts by clicking filters and buttons, previews, submits, approves, pushes |
| **Developer** | http://localhost:5173/**developer** | Writes SQL (and optionally DAX), names the button, tests it, publishes it to marketing |

(With `npm start` everything is served from http://localhost:4000, and `/developer` works the same way.)

In the marketing window:

1. **Data source.** Upload `sample/sample_customers.xlsx` (3,000 fake customers). The validation report shows what was skipped and why.
2. **Build cohort.** Use the pilot filter (last purchase in 2025, so nothing in 2026), add more filters, then **Preview count**. **Show Power BI DAX** shows the query the same filters would send to Power BI.
3. **Save draft**, then **Submit for approval** as *Priya (Marketing)*.
4. Switch **Acting as** to *Rahul (Approver)*, **Approve** (this locks the audience), then **Push to CleverTap**.
5. **Push history** shows each step.

Without CleverTap settings the push is a **dry run**: the CSV is built and measured, and nothing is sent.

Offline checks: `npm test`

## The app at a glance

Use the sidebar to move between the five pages:

| Page | What you do there |
|---|---|
| **Home** | See key numbers and audiences waiting on you, start from a one-click campaign (e.g. "Bought Bed, not Mattress"), see recent sends |
| **Build audience** | Filters on the left. The count, charts and customer table on the right update **live** as you change filters. Click any chart slice or bar to add it as a filter; click a chip's × to remove one. Then "Save audience…" |
| **Audiences** | Tabs by status and search. Click a row for details: filters, delivery rules, locked funnel, timeline. Submit, approve & lock, reject (with a reason) or send, each with a confirmation step |
| **Send history** | Every upload, with its steps; expand a row for detail |
| **Data sources** | Drag-and-drop upload with a validation report, the Power BI setup checklist, dataset cards |

Toast messages confirm each action, and Esc closes dialogs. The developer window (`/developer`) uses the same look.

## Marketing window: audience, charts and "who gets it"

After **Preview count** the marketing window shows three things.

**1. Audience.**
- KPI tiles: customers matched, lifetime spend, average spend and orders per buyer, median days since last order.
- Six charts:
  - customer type (donut);
  - last channel (donut);
  - recency buckets;
  - lifetime spend bands;
  - top categories;
  - top cities.
- Hover any bar or slice for its exact count and share.

**2. Who gets it.** These business rules are saved with the cohort and applied when it's approved:

| Rule | What it does |
|---|---|
| Order customers by + direction | Sorts by lifetime spend, orders, average order value, last or first purchase, registration date or days since last purchase |
| Send to: Only the top… | Keeps the first N in that order, e.g. the top 5,000 spenders (Excel source for now) |
| Control group | Keeps 5/10/20% aside and doesn't send to them, so you can measure campaign lift. The pick is repeatable for a given segment name. |
| Skip people messaged in the last N days | Leaves out anyone already sent in another pushed cohort recently, so customers aren't over-messaged |

A funnel shows the count at each step: matched → after skip → top N → control group → will be sent.

**3. Customers table.**
- Shows the matching customers with **masked** emails, 25 per page.
- Click a blue column header to sort, e.g. lifetime spend high → low or last purchase newest first.
- The table order is the same order "Only the top…" uses.

New built-in filters: **Days since last purchase**, **Avg order value**, **Customer type** (never bought / one-time / repeat).

## Developer window: make a new filter button

1. Open `/developer` (acting as *Dev (Analytics)*) and click **+ New filter button**.
2. **Button name:** what marketing will see, e.g. `Not bought`.
3. **Parameters:** what marketing fills in, e.g. `category` (type *category*). Use them in the query as `:category`.
4. **SQL:** a read-only `SELECT` that returns a `customer_id` column. Tables:
   - `customers`: customer_id, registered_at, first_purchase_date, last_purchase_date, lifetime_order_count, lifetime_gmv, last_channel, city
   - `customer_categories`: customer_id, category
   - `order_lines`: customer_id, order_date, category, amount. This one is filled only when the upload has an **Order Lines** sheet.

   There are no email or phone columns, so queries choose *who*, never contact details.
   ```sql
   SELECT customer_id FROM customers
   EXCEPT
   SELECT customer_id FROM customer_categories WHERE category = :category
   ```
5. **DAX** (optional): the same logic for the Power BI source, as a table of customer IDs. Without it, the button works on Excel uploads only.
6. **Run test** on an uploaded file to get the count, masked sample and run time. Then **Save draft** and **Publish to marketing**.

The button now appears in the marketing window's filter bar (**+ Not bought**). Marketing clicks it, picks the category, and chooses *include* or *exclude*. Each publish creates a new version. Saved cohorts keep the version they were built with, so changing a query never silently changes an existing cohort. **Archive** hides a button.

Three example buttons are created on first run: *Bought X, not Y* · *Not bought since* · *Bought category in year* (needs order lines).

Guards on developer queries:
- one statement only, `SELECT` / `WITH` only;
- every `:param` must be declared;
- values are bound as parameters, never pasted into the SQL;
- only Developer / Admin users can see or change queries.

## "Bought Bed but NOT Mattress"

Two ways to do it:

- **Built-in:** add a condition **Categories → bought … but NOT …**, tick *Bed* under **Bought** and *Mattress* under **NOT bought**.
- **Button:** click **+ Bought X, not Y** and pick Bed / Mattress.

Both give the same result; `npm test` checks this. For time windows such as "bought Bed in 2024", upload a file with an **Order Lines** sheet (Customer ID, Order Date, Category, Amount) and use *Bought category in year*, or write your own button.

## See a full push with a fake CleverTap

```bash
npm run mock:clevertap                 # terminal 1: fake CleverTap on :4010
# in .env:  CT_ACCOUNT_ID=TEST  CT_PASSCODE=TEST  CT_BASE_URL=http://localhost:4010
npm run dev                            # terminal 2
```

After a push, http://localhost:4010/_segments shows what the fake CleverTap received: the uploaded and matched counts. About 90% of emails "have a profile".

## Test the Power BI path with the mock

```bash
python3 tools/powerbi-mock/gen_data.py && python3 tools/powerbi-mock/run.py      # fake Power BI on :8765
```

In `.env`:

```
PBI_TENANT_ID=test  PBI_CLIENT_ID=test  PBI_CLIENT_SECRET=test  PBI_WORKSPACE_ID=w1  PBI_DATASET_ID=d1
PBI_LOGIN_BASE=http://127.0.0.1:8765   PBI_API_BASE=http://127.0.0.1:8765   PBI_PAGE_SIZE=1000
```

Then pick **Power BI** as the source in step 2. The mock understands only the DAX this app generates.

## Connect the real Power BI (what we need from you)

| # | Item | Goes in |
|---|---|---|
| 1 | Power BI admin enables **Dataset Execute Queries REST API** (Admin portal → Tenant settings → Integration) | — |
| 2 | Power BI admin enables **Allow service principals to use Power BI APIs**, or we use a dedicated PPU-licensed user | — |
| 3 | App registration in Microsoft Entra ID: tenant ID, client ID, client secret | `PBI_TENANT_ID`, `PBI_CLIENT_ID`, `PBI_CLIENT_SECRET` |
| 4 | That app added to the workspace (Member/Contributor) with **Build** permission on the semantic model | — |
| 5 | Workspace ID (`app.powerbi.com/groups/<workspaceId>/…`) | `PBI_WORKSPACE_ID` |
| 6 | Semantic model ID (`…/datasets/<datasetId>/…`) | `PBI_DATASET_ID` |
| 7 | Table / column / measure names from the Data pane | `config/powerbi-mapping.json` |
| 8 | Does the model use row-level security? (Service principals can't query RLS models) | — |

Quick check before any setup: run `EVALUATE ROW("connected", 1)` on Microsoft's "Datasets – Execute Queries In Group" **Try It** page.

## Connect the real CleverTap

Set `CT_ACCOUNT_ID`, `CT_PASSCODE`, `CT_REGION` (India = `in1`) and `CT_ADMIN_EMAIL` in `.env`. Before the first real push, confirm two things:

- Customers are identified by **email** in CleverTap.
- PII tokenization is **off**.

## How data is protected

- **Phone numbers** are never read, even when the file has them.
- **On arrival:** each email is normalised, then **encrypted** (AES-256-GCM) and **fingerprinted** (HMAC-SHA256), and the plain value is dropped. The uploaded file is processed in memory and wiped.
- **On screen:** counts and masked samples only (`c***@example.com`).
- **Approval** freezes the audience as a snapshot of customer ID + fingerprint + encrypted email.
- **Push:** only the push step decrypts, in memory. The CSV is never written to disk.
- **Logs** contain counts and a SHA-256 of the CSV, never emails.
- **Retention:** uploaded datasets are deleted after `RETENTION_DAYS` (7 by default).
- **Keys** live in `.env` for now. In production, move them to AWS KMS / Secrets Manager. Changing `ENC_KEY` makes existing snapshots unreadable.

## Not production-ready yet

- **Users** come from a demo switcher. Replace it with company SSO (Entra ID / Google).
- **Storage** is JSON files in `data/`. Move it to MySQL/Postgres.
- **Keys** are in `.env`. Move them to KMS / Secrets Manager.
- **Developer queries** run inside the API process with no time limit. Before real use, move them to a worker thread with a timeout.
- **Scheduled refresh** of approved cohorts isn't built yet. The `ul-scheduler-service` repo is the natural home for it.

## Project layout

```
server/            Express API (TypeScript)
  sources/excel.ts   upload, column mapping, validation, encryption on arrival
  sources/dax.ts     filter rules → DAX (count + paged fetch)
  sources/powerbi.ts Entra token, executeQueries, refresh time
  filter.ts          filter catalog, rule validation, in-memory engine
  customFilters.ts   developer filter buttons: storage, SQL guard + engine (sql.js), DAX rendering, versions
  clevertap.ts       3-step Custom List upload (or dry run)
  mock-clevertap.ts  local fake CleverTap
web/src/           React screens (App = marketing, DevApp = /developer)
config/powerbi-mapping.json   app filters → your model's names
tools/powerbi-mock/           fake Power BI (Python) for testing
```
