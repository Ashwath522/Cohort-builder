/** Writes fake test files to sample/. All people are made up; emails use @example.com. */
import ExcelJS from 'exceljs';
import fs from 'node:fs';

let seed = 42;
const rnd = () => {                       // mulberry32: small, well-mixed PRNG (repeatable sample data)
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const CATS = ['Accessories', 'Bed', 'Decor', 'Dining', 'Furniture-Other', 'Kids', 'Kitchen', 'Living', 'Mattress', 'Outdoor', 'Sofas', 'Wardrobe'];
const START = Date.UTC(2019, 0, 1), END = Date.UTC(2026, 9, 12);
const fmt = (t: number) => { // Power BI India export style: 12/10/2026 12:36:36
  const d = new Date(t), p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};

async function main() {
  fs.mkdirSync('sample', { recursive: true });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Customer Audience');
  ws.addRow(['Customer ID', 'Email', 'Phone', 'Registered At', 'First Purchase Date', 'Last Purchase Date',
             'Total Purchase Count', 'Lifetime GMV', 'Last Channel', 'City', 'Categories Bought']);
  const N = 3000;
  const lines: Array<[number, string, string, number]> = [];     // customer, order date, category, amount
  for (let i = 1; i <= N; i++) {
    const id = 5200000 + i;
    let email = `customer${i}@example.com`;
    if (i % 150 === 0) email = `staff${i}@urbanladder.com`;      // internal account → excluded
    else if (i % 333 === 0) email = 'not-an-email';             // invalid → skipped
    else if (i % 500 === 0) email = ` CUSTOMER${i - 1}@Example.com `; // duplicate after normalising
    const reg = START + rnd() * (END - START);
    const orders = pick([0, 0, 0, 0, 0, 1, 1, 1, 2, 2, 3, 5]);
    const dates = Array.from({ length: orders }, () => reg + rnd() * (END - reg)).sort((a, b) => a - b);
    let gmv = 0; const cats = new Set<string>();
    for (const d of dates) for (let k = 0, n = 1 + Math.floor(rnd() * 2); k < n; k++) {
      const cat = pick(CATS), amt = Math.round(3000 + rnd() * 45000);
      gmv += amt; cats.add(cat); lines.push([id, fmt(d), cat, amt]);
    }
    ws.addRow([
      id, email, `9${String(Math.floor(rnd() * 1e9)).padStart(9, '0')}`, fmt(reg),
      orders ? fmt(dates[0]) : null, orders ? fmt(dates[orders - 1]) : null, orders, gmv,
      orders ? pick(['Online', 'Store', 'App']) : null,
      pick(['Bangalore', 'Mumbai', 'Delhi', 'Hyderabad', 'Pune', 'Chennai']),
      [...cats].join('; '),
    ]);
  }
  const ol = wb.addWorksheet('Order Lines');
  ol.addRow(['Customer ID', 'Order Date', 'Category', 'Amount']);
  for (const l of lines) ol.addRow(l);
  ol.getRow(1).font = { bold: true };
  ws.getRow(1).font = { bold: true };
  await wb.xlsx.writeFile('sample/sample_customers.xlsx');

  const bad = new ExcelJS.Workbook();
  const bs = bad.addWorksheet('Sheet1');
  bs.addRow(['Customer ID', 'Name', 'Last Purchase Date']);
  bs.addRow([1, 'Test', '01/01/2025']);
  await bad.xlsx.writeFile('sample/sample_missing_email.xlsx');
  console.log(`Wrote sample/sample_customers.xlsx (${N} fake customers + order lines) and sample/sample_missing_email.xlsx`);
}
main();
