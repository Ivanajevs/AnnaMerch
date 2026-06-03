// api/admin.js – Vercel Serverless Function
// Schützt alle Admin-Operationen serverseitig mit HTTP Basic Auth.

const SUPABASE_URL = () => process.env.SUPABASE_URL;
const SUPABASE_KEY = () => process.env.SUPABASE_SERVICE_KEY;

// ── HTTP Basic Auth prüfen ──────────────────────────────────────────────
function checkAuth(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Basic ")) return false;

  const base64 = authHeader.slice(6);
  const decoded = Buffer.from(base64, "base64").toString("utf8");
  const [user, pass] = decoded.split(":");

  const validUser = process.env.ADMIN_USER;
  const validPass = process.env.ADMIN_PASS;

  // Timing-safe Vergleich (verhindert Timing-Angriffe)
  const userOk = user === validUser;
  const passOk = pass === validPass;
  return userOk && passOk;
}

export default async function handler(req, res) {
  // CORS
  const allowed = process.env.ALLOWED_ORIGIN || "";
  res.setHeader("Access-Control-Allow-Origin", allowed || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, OPTIONS");

  if (req.method === "OPTIONS") return res.status(200).end();

  // Auth prüfen – bei jedem Request
  if (!checkAuth(req)) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
    return res.status(401).json({ error: "Unauthorized" });
  }

  const url    = SUPABASE_URL();
  const key    = SUPABASE_KEY();
  const action = req.query.action;

  // ── GET /api/admin?action=orders  →  Alle Bestellungen laden ─────────
  if (req.method === "GET" && action === "orders") {
    const r = await fetch(
      `${url}/rest/v1/orders?select=*&order=created_at.desc`,
      { headers: { "apikey": key, "Authorization": `Bearer ${key}` } }
    );
    if (!r.ok) return res.status(500).json({ error: "DB-Fehler" });
    return res.status(200).json(await r.json());
  }

  // ── PATCH /api/admin?action=status  →  Status eines Eintrags updaten ─
  if (req.method === "PATCH" && action === "status") {
    const { id, field, value } = req.body || {};
    const allowed_fields = ["paid", "ordered", "delivered"];
    if (!id || !allowed_fields.includes(field)) {
      return res.status(400).json({ error: "Ungültige Parameter" });
    }

    const r = await fetch(
      `${url}/rest/v1/orders?id=eq.${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: {
          "apikey":        key,
          "Authorization": `Bearer ${key}`,
          "Content-Type":  "application/json",
          "Prefer":        "return=minimal",
        },
        body: JSON.stringify({ [field]: !!value }),
      }
    );
    if (!r.ok) return res.status(500).json({ error: "Update fehlgeschlagen" });
    return res.status(200).json({ ok: true });
  }

  return res.status(404).json({ error: "Route not found" });
}
