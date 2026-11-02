/**
 * Scouting for Food sign-up Worker
 *
 *   POST /submit              receives sign-ups from scouting-for-food-signup.html
 *   GET  /admin               admin page: totals, all responses, CSV download, delete
 *   GET  /api/responses       (admin key required) all responses as JSON
 *   DELETE /api/responses/ID  (admin key required) removes one response
 *
 * Required settings on the Worker:
 *   KV binding     SIGNUPS        -> your KV namespace
 *   Secret         ADMIN_KEY      -> passphrase for the admin page
 * Optional:
 *   Text variable  ALLOWED_ORIGIN -> e.g. https://yourname.github.io (no trailing slash)
 */

const EQUIPMENT_KEYS = ["wagons", "cones", "tables", "canopies", "posterBoard", "markers", "water"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const allowed = env.ALLOWED_ORIGIN || "*";
    const cors = {
      "Access-Control-Allow-Origin": allowed,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    };

    try {
      if (path === "/submit" && request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      if (path === "/submit" && request.method === "POST") return await submit(request, env, cors, allowed);

      if (path === "/admin" && request.method === "GET") {
        return new Response(ADMIN_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
      }

      if (path.startsWith("/api/responses")) {
        if (!(await authorized(request, env))) return json({ ok: false, error: "Admin key is incorrect." }, 401);
        if (request.method === "GET" && path === "/api/responses") return json({ ok: true, responses: await listAll(env) });
        if (request.method === "DELETE") {
          const id = decodeURIComponent(path.split("/").pop());
          if (!/^[\w-]+$/.test(id)) return json({ ok: false, error: "Invalid ID." }, 400);
          await env.SIGNUPS.delete("signup:" + id);
          return json({ ok: true });
        }
      }

      if (path === "/") return new Response("Scouting for Food sign-up endpoint is running.", { headers: { "Content-Type": "text/plain" } });
      return new Response("Not found", { status: 404 });
    } catch (err) {
      return json({ ok: false, error: "Server error: " + err.message }, 500, path === "/submit" ? cors : {});
    }
  }
};

/* ---------- Submit ---------- */
async function submit(request, env, cors, allowed) {
  const origin = request.headers.get("Origin") || "";
  if (allowed !== "*" && origin !== allowed) return json({ ok: false, error: "This form is not allowed to submit here." }, 403, cors);

  const raw = await request.text();
  if (raw.length > 20000) return json({ ok: false, error: "Submission is too large." }, 413, cors);

  let d;
  try { d = JSON.parse(raw); } catch { return json({ ok: false, error: "Submission could not be read." }, 400, cors); }
  if (d.website) return json({ ok: true }, 200, cors); // spam trap: pretend success

  const rec = clean(d);
  if (!rec.name || !rec.email) return json({ ok: false, error: "Name and email are required." }, 400, cors);

  const id = Date.now() + "-" + crypto.randomUUID().slice(0, 8);
  rec.id = id;
  rec.submittedAt = new Date().toISOString();
  await env.SIGNUPS.put("signup:" + id, JSON.stringify(rec));
  return json({ ok: true }, 200, cors);
}

function clean(d) {
  const s = (v, n = 500) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  const arr = v => (Array.isArray(v) ? v.filter(x => typeof x === "string").map(x => x.trim().slice(0, 120)).slice(0, 20) : []);
  const n = v => { const x = parseInt(v, 10); return Number.isFinite(x) && x > 0 ? Math.min(x, 999) : 0; };
  const equipment = {};
  EQUIPMENT_KEYS.forEach(k => (equipment[k] = n((d.equipment || {})[k])));
  return {
    name: s(d.name, 150), phone: s(d.phone, 40), email: s(d.email, 200), unit: s(d.unit, 100),
    personType: s(d.personType, 50), guardianName: s(d.guardianName, 150), guardianPhone: s(d.guardianPhone, 40),
    signingUpFor: arr(d.signingUpFor), shifts: arr(d.shifts), extraPeople: n(d.extraPeople),
    roles: arr(d.roles), notes: s(d.notes, 2000), equipment,
    otherItem: s(d.otherItem, 150), otherQty: n(d.otherQty), otherReturn: !!d.otherReturn,
    returnPickup: s(d.returnPickup, 100), scoutHouseAvail: s(d.scoutHouseAvail, 300),
    carryHelp: arr(d.carryHelp), contactPref: s(d.contactPref, 50)
  };
}

/* ---------- Admin data ---------- */
async function authorized(request, env) {
  const given = request.headers.get("X-Admin-Key") || "";
  const expected = env.ADMIN_KEY || "";
  if (!expected || given.length !== expected.length) return false;
  const enc = new TextEncoder();
  return crypto.subtle.timingSafeEqual(enc.encode(given), enc.encode(expected));
}

async function listAll(env) {
  const names = [];
  let cursor;
  do {
    const page = await env.SIGNUPS.list({ prefix: "signup:", cursor });
    names.push(...page.keys.map(k => k.name));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  const out = [];
  for (let i = 0; i < names.length; i += 50) {
    const batch = await Promise.all(names.slice(i, i + 50).map(k => env.SIGNUPS.get(k, "json")));
    out.push(...batch.filter(Boolean));
  }
  return out.sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : 1));
}

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...headers } });
}

/* ---------- Admin page ---------- */
const ADMIN_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scouting for Food sign-ups: admin</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🥫</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&family=Young+Serif&display=swap" rel="stylesheet">
<style>
:root{color-scheme:light;--bg:#F6F5F8;--surface:#FFF;--ink:#241C2B;--muted:#5E5568;--line:#DCD6E2;--plum:#5A2D6B;--plum-ink:#FFF;--plum-soft:#F0E9F4;--error:#A3262E;
--serif:"Young Serif",Georgia,serif;--sans:"Atkinson Hyperlegible","Segoe UI",system-ui,sans-serif}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#18141C;--surface:#221C28;--ink:#EEE9F2;--muted:#B3A9BD;--line:#3A3243;--plum:#C9A6DA;--plum-ink:#1B1220;--plum-soft:#2E2436;--error:#F08A90}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);line-height:1.5}
.wrap{max-width:1200px;margin:0 auto;padding:2rem 1.25rem 3rem}
h1{font-family:var(--serif);font-weight:400;font-size:2rem;margin:0 0 1rem}
h2{font-family:var(--serif);font-weight:400;font-size:1.25rem;margin:0 0 .5rem}
input{font:inherit;color:var(--ink);background:var(--surface);border:1.5px solid var(--line);border-radius:6px;padding:.6rem .75rem;min-width:260px}
.btn{font:inherit;font-weight:700;background:var(--plum);color:var(--plum-ink);border:0;border-radius:6px;padding:.6rem 1.2rem;cursor:pointer}
.btn.secondary{background:transparent;color:var(--plum);border:1.5px solid var(--plum)}
.btn.small{padding:.3rem .7rem;font-size:.85rem}
button:focus-visible,input:focus-visible{outline:3px solid var(--plum);outline-offset:2px}
.bar{display:flex;gap:.75rem;flex-wrap:wrap;align-items:center;margin-bottom:1.5rem}
.msg{color:var(--muted)} .msg.err{color:var(--error)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:1rem;margin-bottom:2rem}
.card{background:var(--surface);border:1.5px solid var(--line);border-radius:8px;padding:1rem 1.1rem}
.card dl{display:grid;grid-template-columns:1fr auto;gap:.3rem 1rem;margin:0}
.card dt{color:var(--muted)} .card dd{margin:0;font-weight:700;text-align:right}
.tablewrap{overflow-x:auto;background:var(--surface);border:1.5px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%;font-size:.9rem}
th,td{text-align:left;vertical-align:top;padding:.55rem .7rem;border-bottom:1px solid var(--line)}
th{background:var(--plum-soft);position:sticky;top:0;white-space:nowrap}
td{min-width:110px}
[hidden]{display:none!important}
</style>
</head>
<body>
<div class="wrap">
<h1>Scouting for Food sign-ups</h1>

<form id="login" class="bar">
  <label for="key">Admin key</label>
  <input type="password" id="key" autocomplete="current-password" required>
  <button class="btn" type="submit">View sign-ups</button>
  <span class="msg" id="loginMsg" role="status"></span>
</form>

<div id="app" hidden>
  <div class="bar">
    <button class="btn" id="refresh" type="button">Refresh</button>
    <button class="btn secondary" id="csv" type="button">Download CSV</button>
    <button class="btn secondary" id="signout" type="button">Sign out</button>
    <span class="msg" id="appMsg" role="status"></span>
  </div>
  <div class="cards" id="cards"></div>
  <h2>All responses</h2>
  <div class="tablewrap"><table><thead><tr id="thead"></tr></thead><tbody id="tbody"></tbody></table></div>
</div>
</div>

<script>
var EQUIP = [["wagons","Wagons"],["cones","Traffic cones"],["tables","Folding tables"],["canopies","Canopies"],["posterBoard","Poster board (sheets)"],["markers","Markers (packs)"],["water","Bottled water (cases)"]];
var COLS = [
  ["Submitted", function(r){ return new Date(r.submittedAt).toLocaleString(); }],
  ["Name", function(r){ return r.name; }],
  ["Phone", function(r){ return r.phone; }],
  ["Email", function(r){ return r.email; }],
  ["Unit", function(r){ return r.unit; }],
  ["I am a", function(r){ return r.personType; }],
  ["Parent/guardian", function(r){ return [r.guardianName, r.guardianPhone].filter(Boolean).join(", "); }],
  ["Signing up to", function(r){ return (r.signingUpFor||[]).join("; "); }],
  ["Shifts", function(r){ return (r.shifts||[]).join("; "); }],
  ["Additional people", function(r){ return r.extraPeople || ""; }],
  ["Roles", function(r){ return (r.roles||[]).join("; "); }],
  ["Notes", function(r){ return r.notes; }],
  ["Equipment", function(r){ return equipText(r); }],
  ["Item return", function(r){ return r.returnPickup; }],
  ["Scout house availability", function(r){ return r.scoutHouseAvail; }],
  ["Carry help", function(r){ return (r.carryHelp||[]).join("; "); }],
  ["Contact by", function(r){ return r.contactPref; }]
];
var data = [];
var $ = function(s){ return document.querySelector(s); };

function equipText(r){
  var parts = [];
  EQUIP.forEach(function(e){ var q = (r.equipment||{})[e[0]]; if (q) parts.push(q + " " + e[1]); });
  if (r.otherItem && r.otherQty) parts.push(r.otherQty + " " + r.otherItem + (r.otherReturn ? " (return)" : ""));
  return parts.join("; ");
}
function key(){ return sessionStorage.getItem("sff_admin_key") || ""; }

async function load(){
  $("#appMsg").textContent = "Loading...";
  var res = await fetch("/api/responses", { headers: { "X-Admin-Key": key() } });
  if (res.status === 401){ sessionStorage.removeItem("sff_admin_key"); showLogin("Admin key is incorrect."); return; }
  var body = await res.json();
  if (!body.ok){ $("#appMsg").textContent = body.error; return; }
  data = body.responses;
  $("#login").hidden = true; $("#app").hidden = false;
  render();
  $("#appMsg").textContent = data.length + " response" + (data.length === 1 ? "" : "s") + ", updated " + new Date().toLocaleTimeString();
}

function card(title, rows){
  var c = document.createElement("div"); c.className = "card";
  var h = document.createElement("h2"); h.textContent = title; c.appendChild(h);
  var dl = document.createElement("dl");
  rows.forEach(function(r){
    var dt = document.createElement("dt"); dt.textContent = r[0];
    var dd = document.createElement("dd"); dd.textContent = r[1];
    dl.appendChild(dt); dl.appendChild(dd);
  });
  c.appendChild(dl); return c;
}

function render(){
  var vol = data.filter(function(r){ return (r.signingUpFor||[]).indexOf("Volunteer") > -1; });
  var people = vol.reduce(function(s, r){ return s + 1 + (r.extraPeople||0); }, 0);
  var shiftCounts = {};
  vol.forEach(function(r){ (r.shifts||[]).forEach(function(s){
    shiftCounts[s] = shiftCounts[s] || [0, 0];
    shiftCounts[s][0] += 1; shiftCounts[s][1] += 1 + (r.extraPeople||0);
  }); });
  var eq = EQUIP.map(function(e){ return [e[1], data.reduce(function(s, r){ return s + ((r.equipment||{})[e[0]]||0); }, 0)]; });
  data.forEach(function(r){ if (r.otherItem && r.otherQty) eq.push([r.otherItem + " (other)", r.otherQty]); });
  var site = data.filter(function(r){ return /^At the drop-off/.test(r.returnPickup||""); }).length;
  var house = data.filter(function(r){ return r.returnPickup === "Later at the scout house"; }).length;

  var cards = $("#cards"); cards.innerHTML = "";
  cards.appendChild(card("Sign-ups", [["Total responses", data.length], ["Volunteering", vol.length], ["People including additional", people]]));
  var shiftRows = Object.keys(shiftCounts).map(function(s){ return [s, shiftCounts[s][0] + " signed up, " + shiftCounts[s][1] + " people"]; });
  cards.appendChild(card("Per shift", shiftRows.length ? shiftRows : [["No shifts yet", ""]]));
  cards.appendChild(card("Equipment pledged", eq));
  cards.appendChild(card("Item returns", [["At the drop-off site", site], ["At the scout house", house]]));

  var head = $("#thead"); head.innerHTML = "";
  COLS.concat([[""]]).forEach(function(c){ var th = document.createElement("th"); th.textContent = c[0]; head.appendChild(th); });
  var tb = $("#tbody"); tb.innerHTML = "";
  data.slice().reverse().forEach(function(r){
    var tr = document.createElement("tr");
    COLS.forEach(function(c){ var td = document.createElement("td"); td.textContent = c[1](r) || ""; tr.appendChild(td); });
    var td = document.createElement("td");
    var b = document.createElement("button"); b.type = "button"; b.className = "btn secondary small"; b.textContent = "Delete";
    b.addEventListener("click", function(){ remove(r); });
    td.appendChild(b); tr.appendChild(td); tb.appendChild(tr);
  });
}

async function remove(r){
  if (!confirm("Delete the response from " + r.name + "? This cannot be undone.")) return;
  var res = await fetch("/api/responses/" + encodeURIComponent(r.id), { method: "DELETE", headers: { "X-Admin-Key": key() } });
  var body = await res.json();
  if (!body.ok){ $("#appMsg").textContent = body.error; return; }
  load();
}

function csv(){
  var esc = function(v){ v = String(v == null ? "" : v); if (/^[=+\-@]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };
  var headers = COLS.map(function(c){ return c[0]; }).filter(function(h){ return h !== "Equipment"; })
    .concat(EQUIP.map(function(e){ return e[1]; }), ["Other item", "Other quantity", "Return other item"]);
  var lines = [headers.map(esc).join(",")];
  data.forEach(function(r){
    var row = COLS.filter(function(c){ return c[0] !== "Equipment"; }).map(function(c){ return c[1](r); })
      .concat(EQUIP.map(function(e){ return (r.equipment||{})[e[0]] || 0; }), [r.otherItem, r.otherQty || "", r.otherReturn ? "Yes" : ""]);
    lines.push(row.map(esc).join(","));
  });
  var blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "scouting-for-food-signups.csv";
  document.body.appendChild(a); a.click(); a.remove();
}

function showLogin(msg){ $("#app").hidden = true; $("#login").hidden = false; $("#loginMsg").textContent = msg || ""; $("#key").focus(); }

$("#login").addEventListener("submit", function(e){ e.preventDefault(); sessionStorage.setItem("sff_admin_key", $("#key").value); $("#key").value = ""; load(); });
$("#refresh").addEventListener("click", load);
$("#csv").addEventListener("click", csv);
$("#signout").addEventListener("click", function(){ sessionStorage.removeItem("sff_admin_key"); showLogin("Signed out."); });
if (key()) load(); else showLogin();
</script>
</body>
</html>`;
