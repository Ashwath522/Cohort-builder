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

Open http://localhost:5173, then:

1. **Data source.** Upload `sample/sample_customers.xlsx` (3,000 fake customers). The validation report shows what was skipped and why.
2. **Build cohort.** Use the pilot filter (last purchase in 2025, so nothing in 2026), add more filters, then **Preview count**. **Show Power BI DAX** shows the query the same filters would send to Power BI.
3. **Save draft**, then **Submit for approval** as *Priya (Marketing)*.
4. Switch **Acting as** to *Rahul (Approver)*, **Approve** (this locks the audience), then **Push to CleverTap**.
5. **Push history** shows each step.

Without CleverTap settings the push is a **dry run**: the CSV is built and measured, and nothing is sent.

Offline checks: `npm test`

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
- **Scheduled refresh** of approved cohorts isn't built yet. The `ul-scheduler-service` repo is the natural home for it.

## Project layout

```
server/            Express API (TypeScript)
  sources/excel.ts   upload, column mapping, validation, encryption on arrival
  sources/dax.ts     filter rules → DAX (count + paged fetch)
  sources/powerbi.ts Entra token, executeQueries, refresh time
  filter.ts          filter catalog, rule validation, in-memory engine
  clevertap.ts       3-step Custom List upload (or dry run)
  mock-clevertap.ts  local fake CleverTap
web/src/           React screens
config/powerbi-mapping.json   app filters → your model's names
tools/powerbi-mock/           fake Power BI (Python) for testing
```
# Cohort-builder
