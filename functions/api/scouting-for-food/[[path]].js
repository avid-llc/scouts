/**
 * Scouting for Food sign-up backend (Cloudflare Pages Function)
 * Route: /api/scouting-for-food/*
 *
 *   POST   /api/scouting-for-food/submit          saves a sign-up (public)
 *   GET    /api/scouting-for-food/responses       all sign-ups (admin key required)
 *   DELETE /api/scouting-for-food/responses/ID    removes one sign-up (admin key required)
 *
 * Pages project settings:
 *   KV binding  SIGNUPS    -> your KV namespace
 *   Secret      ADMIN_KEY  -> passphrase for scouting-for-food-admin.html
 */

const EQUIPMENT_KEYS = ["wagons", "cones", "tables", "canopies", "posterBoard", "markers", "water"];

export async function onRequest({ request, env, params }) {
  const route = (params.path || []).join("/");
  try {
    if (!env.SIGNUPS) return json({ ok: false, error: "Storage is not connected. Add the SIGNUPS KV binding and redeploy." }, 500);

    if (route === "submit" && request.method === "POST") return await submit(request, env);

    if (route === "responses" || route.startsWith("responses/")) {
      if (!(await authorized(request, env))) return json({ ok: false, error: "Admin key is incorrect." }, 401);
      if (route === "responses" && request.method === "GET") return json({ ok: true, responses: await listAll(env) });
      if (request.method === "DELETE") {
        const id = route.split("/")[1] || "";
        if (!/^[\w-]+$/.test(id)) return json({ ok: false, error: "Invalid ID." }, 400);
        await env.SIGNUPS.delete("signup:" + id);
        return json({ ok: true });
      }
    }
    return json({ ok: false, error: "Not found." }, 404);
  } catch (err) {
    return json({ ok: false, error: "Server error: " + err.message }, 500);
  }
}

/* ---------- Submit ---------- */
async function submit(request, env) {
  // Only accept submissions from this site's own form.
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return json({ ok: false, error: "Submission not allowed." }, 403);

  const raw = await request.text();
  if (raw.length > 20000) return json({ ok: false, error: "Submission is too large." }, 413);

  let d;
  try { d = JSON.parse(raw); } catch { return json({ ok: false, error: "Submission could not be read." }, 400); }
  if (d.website) return json({ ok: true }); // spam trap: pretend success

  const rec = clean(d);
  if (!rec.name || !rec.email) return json({ ok: false, error: "Name and email are required." }, 400);

  rec.id = Date.now() + "-" + crypto.randomUUID().slice(0, 8);
  rec.submittedAt = new Date().toISOString();
  await env.SIGNUPS.put("signup:" + rec.id, JSON.stringify(rec));
  return json({ ok: true });
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

/* ---------- Admin ---------- */
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

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
