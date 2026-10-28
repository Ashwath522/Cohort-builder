"""Local stand-ins for the two external services, mimicking their real HTTP contracts.

1) Power BI REST  : POST /v1.0/myorg/groups/{g}/datasets/{d}/executeQueries
   + Entra token  : POST /{tenant}/oauth2/v2.0/token
   The DAX engine itself only exists inside Power BI, so this mock understands
   the SUBSET of DAX our query templates emit and evaluates it on SQLite.
   Anything outside that subset is rejected with an error, like a bad query would be.
2) CleverTap Custom List API (3 steps) under /ct/...
"""
import json, os, re, sqlite3, threading, uuid, csv, io, random
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DB = os.path.join(os.path.dirname(__file__), "model.db")
ROW_LIMIT = 1000          # real API: 100,000 rows / 1M values; scaled down to force paging
TOKENS, SEGMENTS, UPLOADS = set(), {}, {}
CT_ACCOUNT, CT_PASSCODE = "TEST-ACCOUNT", "TEST-PASSCODE"
random.seed(7)
import hashlib
CT_PROFILES = {hashlib.sha1(f"fynd-{i}".encode()).hexdigest()[:24] for i in range(1, 20001) if random.random() < 0.9}  # ~90% of Fynd IDs have a CT profile
API_CALLS = []

# ───────────────────────── DAX subset → SQL ─────────────────────────
class DaxError(Exception): pass

COL = r"'?Customers'?\[([^\]]+)\]|\[([^\]]+)\]"          # Customers[X] or measure [X]
CATS_EXPR = r"CALCULATETABLE\(\s*VALUES\(\s*'?OrderLines'?\[Category\]\s*\)\s*\)"

def _split_top(s, sep="&&"):
    out, depth, buf, i, q = [], 0, "", 0, False
    while i < len(s):
        ch = s[i]
        if ch == '"': q = not q
        if not q:
            if ch == "(": depth += 1
            elif ch == ")": depth -= 1
            elif depth == 0 and s.startswith(sep, i):
                out.append(buf.strip()); buf = ""; i += len(sep); continue
        buf += ch; i += 1
    out.append(buf.strip()); return out

def _call_args(s, fname):
    """Return the argument string of the first fname(...) call (balanced parens)."""
    m = re.search(re.escape(fname) + r"\s*\(", s)
    if not m: return None
    i, depth, q = m.end(), 1, False
    for j in range(i, len(s)):
        if s[j] == '"': q = not q
        if q: continue
        depth += s[j] == "("; depth -= s[j] == ")"
        if depth == 0: return s[i:j]
    raise DaxError("Unbalanced parentheses")

def _col(m): return m.group(1) or m.group(2)

def cond_to_sql(c, vars_, params):
    c = c.strip()
    while c.startswith("(") and c.endswith(")") and _call_args("X" + c, "X") == c[1:-1]:
        c = c[1:-1].strip()
    if "||" in c and len(_split_top(c, "||")) > 1:
        return "(" + " OR ".join(cond_to_sql(p, vars_, params) for p in _split_top(c, "||")) + ")"
    if len(_split_top(c)) > 1:
        return "(" + " AND ".join(cond_to_sql(p, vars_, params) for p in _split_top(c)) + ")"
    m = re.fullmatch(rf"(NOT\s+)?ISBLANK\(\s*(?:{COL})\s*\)", c)
    if m:
        col = m.group(2) or m.group(3)
        return f'c."{col}" IS {"NOT " if m.group(1) else ""}NULL'
    m = re.fullmatch(r"NOT\s*\((.*)\)", c, re.S)
    if m and _call_args("X(" + m.group(1) + ")", "X") == m.group(1):
        return "NOT (" + cond_to_sql(m.group(1), vars_, params) + ")"
    m = re.fullmatch(rf"NOT\s+ISEMPTY\(\s*INTERSECT\(\s*(\w+)\s*,\s*{CATS_EXPR}\s*\)\s*\)", c)
    if m:
        vals = vars_[m.group(1)]; params.extend(vals)
        return (f'EXISTS (SELECT 1 FROM OrderLines o WHERE o."Customer ID"=c."Customer ID" '
                f'AND o.Category IN ({",".join("?" * len(vals))}))')
    m = re.fullmatch(rf"(?:{COL})\s*(>=|<=|>|<|=)\s*DATE\((\d+),\s*(\d+),\s*(\d+)\)", c)
    if m:  # DAX: BLANK behaves like 0 in comparisons, so BLANK < DATE(...) is TRUE
        col, op = _col(m), m.group(3)
        params.append(f"{int(m.group(4)):04d}-{int(m.group(5)):02d}-{int(m.group(6)):02d}")
        return f'COALESCE(c."{col}", \'0000-00-00\') {op} ?'
    m = re.fullmatch(rf"(?:{COL})\s*(>=|<=|>|<|=)\s*(-?\d+(?:\.\d+)?)", c)
    if m:
        params.append(float(m.group(4)))
        return f'COALESCE(c."{_col(m)}", 0) {m.group(3)} ?'
    m = re.fullmatch(rf"(?:{COL})\s+IN\s+\{{(.*)\}}", c)
    if m:
        vals = re.findall(r'"((?:[^"]|"")*)"', m.group(3))
        params.extend(v.replace('""', '"') for v in vals)
        return f'c."{_col(m)}" IN ({",".join("?" * len(vals))})'
    m = re.fullmatch(rf"COUNTROWS\(\s*INTERSECT\(\s*(\w+)\s*,\s*{CATS_EXPR}\s*\)\s*\)\s*=\s*(\d+)", c)
    if m:  # bought ALL of
        vals = vars_[m.group(1)]; params.extend(vals); params.append(int(m.group(2)))
        return (f'(SELECT COUNT(DISTINCT o.Category) FROM OrderLines o WHERE o."Customer ID"=c."Customer ID" '
                f'AND o.Category IN ({",".join("?" * len(vals))})) = ?')
    m = re.fullmatch(rf"ISEMPTY\(\s*INTERSECT\(\s*(\w+)\s*,\s*{CATS_EXPR}\s*\)\s*\)", c)
    if m:  # bought NONE of
        vals = vars_[m.group(1)]; params.extend(vals)
        return (f'NOT EXISTS (SELECT 1 FROM OrderLines o WHERE o."Customer ID"=c."Customer ID" '
                f'AND o.Category IN ({",".join("?" * len(vals))}))')
    raise DaxError(f"Unsupported or invalid expression: {c[:120]}")

def run_dax(dax):
    dax = re.sub(r"--[^\n]*", "", dax)
    vars_ = {m.group(1): [v.replace('""', '"') for v in re.findall(r'"((?:[^"]|"")*)"', m.group(2))]
             for m in re.finditer(r"VAR\s+(\w+)\s*=\s*\{([^}]*)\}", dax)}
    body = dax.split("EVALUATE", 1)[-1].strip()
    fargs = _call_args(body, "FILTER")
    if fargs is None:
        if re.fullmatch(r'ROW\(\s*"(\w+)"\s*,\s*1\s*\)', body.strip()):
            return [{f"[{re.search(r'\"(\w+)\"', body).group(1)}]": 1}]
        raise DaxError("Query must FILTER the Customers table")
    tbl, cond = fargs.split(",", 1)
    if tbl.strip().strip("'") != "Customers": raise DaxError(f"Cannot find table {tbl.strip()}")
    params = []; where = cond_to_sql(cond, vars_, params)
    con = sqlite3.connect(DB); con.row_factory = sqlite3.Row
    try:
        if body.startswith("ROW"):
            label = re.match(r'ROW\(\s*"(\w+)"', body).group(1)
            n = con.execute(f"SELECT COUNT(*) FROM Customers c WHERE {where}", params).fetchone()[0]
            return [{f"[{label}]": n}]
        if body.startswith("TOPN"):
            top_n = int(re.match(r"TOPN\(\s*(\d+)", body).group(1))
            sel = _call_args(body, "SELECTCOLUMNS")
            pairs = re.findall(rf'"(\w+)"\s*,\s*(?:{COL})', sel)
            cols = ", ".join(f'c."{a or b}" AS "[{k}]"' for k, a, b in pairs)
            order_key = re.search(r"\[(\w+)\]\s*,\s*ASC\s*\)", body).group(1)
            order_col = dict((k, a or b) for k, a, b in pairs)[order_key]
            rows = con.execute(f'SELECT {cols} FROM Customers c WHERE {where} ORDER BY c."{order_col}" '
                               f'LIMIT ?', params + [top_n]).fetchall()
            return [dict(r) for r in rows][:ROW_LIMIT]          # API silently caps rows
        raise DaxError("Unsupported EVALUATE shape")
    finally:
        con.close()

# ───────────────────────── HTTP handler ─────────────────────────
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, obj=None, raw=None):
        body = raw if raw is not None else json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def _body(self):
        return self.rfile.read(int(self.headers.get("Content-Length", 0)))
    def _ct_auth(self):
        return (self.headers.get("X-CleverTap-Account-Id") == CT_ACCOUNT and
                self.headers.get("X-CleverTap-Passcode") == CT_PASSCODE)

    def do_POST(self):
        p = self.path; API_CALLS.append(("POST", p.split("?")[0]))
        if re.fullmatch(r"/[\w-]+/oauth2/v2\.0/token", p):
            form = dict(x.split("=", 1) for x in self._body().decode().split("&"))
            if form.get("grant_type") != "client_credentials" or "analysis.windows.net" not in form.get("scope", "").replace("%3A", ":").replace("%2F", "/"):
                return self._send(400, {"error": "invalid_request"})
            t = uuid.uuid4().hex; TOKENS.add(t)
            return self._send(200, {"token_type": "Bearer", "expires_in": 3599, "access_token": t})
        if re.fullmatch(r"/v1\.0/myorg/groups/[\w-]+/datasets/[\w-]+/executeQueries", p):
            if self.headers.get("Authorization", "").replace("Bearer ", "") not in TOKENS:
                return self._send(401, {"error": {"code": "PowerBINotAuthorizedException"}})
            req = json.loads(self._body()); q = req["queries"]
            if len(q) != 1: return self._send(400, {"error": {"code": "BadRequest", "message": "Only one query per request"}})
            try:
                rows = run_dax(q[0]["query"])
            except DaxError as e:
                return self._send(400, {"error": {"code": "DatasetExecuteQueriesError",
                                     "pbi.error": {"details": [{"code": "DetailsMessage", "detail": {"value": str(e)}}]}}})
            return self._send(200, {"results": [{"tables": [{"rows": rows}]}]})
        if p == "/ct/get_custom_list_segment_url":
            if not self._ct_auth(): return self._send(401, {"status": "fail", "error": "Invalid credentials"})
            tok = uuid.uuid4().hex; UPLOADS[tok] = None
            return self._send(200, {"status": "success",
                                    "presignedS3URL": f"http://127.0.0.1:{self.server.server_port}/ct/s3/{tok}"})
        if p == "/ct/upload_custom_list_segment_completed":
            if not self._ct_auth(): return self._send(401, {"status": "fail", "error": "Invalid credentials"})
            req = json.loads(self._body())
            miss = [k for k in ("name", "email", "filename", "creator", "url") if k not in req]
            if miss: return self._send(400, {"status": "fail", "error": "missing_fields", "fields": miss})
            tok = req["url"].rsplit("/", 1)[-1]
            if UPLOADS.get(tok) is None: return self._send(400, {"status": "fail", "error": "file_not_found"})
            if req["name"] in SEGMENTS and not req.get("replace"):
                return self._send(400, {"status": "fail", "error": "duplicate_name"})
            ids = [r["identity"] for r in csv.DictReader(io.StringIO(UPLOADS[tok].decode("utf-8")))]
            SEGMENTS[req["name"]] = {"uploaded": len(ids), "matched": sum(i in CT_PROFILES for i in ids)}
            UPLOADS[tok] = "USED"
            return self._send(200, {"status": "success"})
        self._send(404, {"error": "not found"})

    def do_PUT(self):
        API_CALLS.append(("PUT", "/ct/s3/<presigned>"))
        m = re.fullmatch(r"/ct/s3/(\w+)", self.path)
        if not m or m.group(1) not in UPLOADS: return self._send(403, raw=b"AccessDenied")
        if UPLOADS[m.group(1)] == "USED": return self._send(400, {"error": "url_already_used"})
        UPLOADS[m.group(1)] = self._body(); self._send(200, raw=b"")

    def do_GET(self):  # mock-only helper to inspect what CleverTap received
        if self.path == "/ct/_segments": return self._send(200, SEGMENTS)
        if self.path == "/_calls": return self._send(200, API_CALLS)
        if re.fullmatch(r"/v1\.0/myorg/groups/[\w-]+/datasets/[\w-]+/refreshes\?\$top=\d+", self.path):
            return self._send(200, {"value": [{"status": "Completed", "endTime": "2026-10-21T02:00:00Z"}]})
        self._send(404, {"error": "not found"})

def start(port=8765):
    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv
