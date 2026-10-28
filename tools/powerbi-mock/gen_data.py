"""Generate a fake Power BI-like model (Customers + OrderLines) in SQLite.
All data is synthetic: emails use @example.com, no real customers.
The app only ever queries "Customer ID" and "Fynd User ID"; the Email column is there to prove it is never read."""
import random, sqlite3, datetime as dt, os, hashlib

random.seed(42)
DB = os.path.join(os.path.dirname(__file__), "model.db")
CATS = ["Accessories", "Bed", "Decor", "Dining", "Furniture-Other", "Kids",
        "Kitchen", "Living", "Mattress", "Outdoor", "Sofas", "Wardrobe"]
N_CUSTOMERS = 20000
START, END = dt.date(2019, 1, 1), dt.date(2026, 10, 12)

def rand_date(a, b):
    return a + dt.timedelta(days=random.randint(0, (b - a).days))

con = sqlite3.connect(DB)
con.executescript("""
DROP TABLE IF EXISTS Customers; DROP TABLE IF EXISTS OrderLines;
CREATE TABLE Customers("Customer ID" INTEGER PRIMARY KEY, "Fynd User ID" TEXT, "Email" TEXT, "Registered At" TEXT,
  "First_Purchase_Date" TEXT, "Last_Purchase_Date" TEXT, "Lifetime_Order_Count" INTEGER,
  "Lifetime_GMV" REAL, "Last_Channel" TEXT);
CREATE TABLE OrderLines("Order ID" INTEGER, "Customer ID" INTEGER, "Order Date" TEXT,
  "Category" TEXT, "Line_GMV" REAL);
""")
order_id = 1
def email_for(cid):  # sprinkle in real-world mess: staff accounts, junk, duplicates
    if cid % 150 == 0: return f"staff{cid}@urbanladder.com"
    if cid % 333 == 0: return "not-an-email"
    if cid % 500 == 0: return f" USER{cid-1}@Example.com "   # same person as previous id
    return f"user{cid}@example.com"
def fynd_id_for(cid):  # Fynd user IDs look like 24-hex object IDs; a few customers have none yet
    return None if cid % 333 == 0 else hashlib.sha1(f"fynd-{cid}".encode()).hexdigest()[:24]
for cid in range(1, N_CUSTOMERS + 1):
    reg = rand_date(START, END)
    n_orders = random.choices([0, 1, 2, 3, 5], [62, 22, 9, 5, 2])[0]
    dates, gmv, chan = [], 0.0, None
    for _ in range(n_orders):
        d = rand_date(reg, END)
        dates.append(d)
        for _ in range(random.randint(1, 3)):
            amt = round(random.uniform(800, 90000), 2)
            gmv += amt
            con.execute("INSERT INTO OrderLines VALUES (?,?,?,?,?)",
                        (order_id, cid, d.isoformat(), random.choice(CATS), amt))
        chan = random.choice(["Online", "Store", "App"])
        order_id += 1
    con.execute("INSERT INTO Customers VALUES (?,?,?,?,?,?,?,?,?)", (
        cid, fynd_id_for(cid), email_for(cid), reg.isoformat(),
        min(dates).isoformat() if dates else None,
        max(dates).isoformat() if dates else None,
        n_orders, round(gmv, 2), chan))
con.commit()
print("customers:", con.execute("SELECT COUNT(*) FROM Customers").fetchone()[0],
      "| purchasers:", con.execute("SELECT COUNT(*) FROM Customers WHERE Lifetime_Order_Count>0").fetchone()[0],
      "| order lines:", con.execute("SELECT COUNT(*) FROM OrderLines").fetchone()[0])
