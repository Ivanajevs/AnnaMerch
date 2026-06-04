// api/admin.js – Vercel Serverless Function
// Schützt alle Admin-Operationen serverseitig mit HTTP Basic Auth.

const SUPABASE_URL = () => process.env.SUPABASE_URL;
const SUPABASE_KEY = () => process.env.SUPABASE_SERVICE_KEY;

// ── HTTP Basic Auth prüfen ──────────────────────────────────────────────
function checkAuth(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Basic ")) return false;
  const base64  = authHeader.slice(6);
  const decoded = Buffer.from(base64, "base64").toString("utf8");
  const [user, pass] = decoded.split(":");
  return user === process.env.ADMIN_USER && pass === process.env.ADMIN_PASS;
}

// ── Brevo E-Mail senden ─────────────────────────────────────────────────
async function sendBrevoEmail(toEmail, toName, templateId, params) {
  if (!templateId) return; // Kein Template gesetzt → E-Mail überspringen
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "accept":       "application/json",
      "api-key":      process.env.BREVO_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: [{ email: toEmail, name: toName }],
      templateId: parseInt(templateId),
      params,
    }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    console.error(`Brevo error (template ${templateId}):`, e.message || r.status);
  }
}

// ── Pro Status + Richtung eine eigene Brevo-Template-ID ────────────────
// Jedes Feld hat eine Template für "aktiviert" und "deaktiviert".
// Nicht gesetzte Env-Variablen → keine E-Mail für diesen Fall.
const STATUS_CONFIG = {
  paid: {
    on:  { label: "Bezahlung bestätigt",         tplEnv: "BREVO_TPL_PAID_ON"       },
    off: { label: "Bezahlung zurückgesetzt",      tplEnv: "BREVO_TPL_PAID_OFF"      },
  },
  ordered: {
    on:  { label: "Bestellung aufgegeben",        tplEnv: "BREVO_TPL_ORDERED_ON"    },
    off: { label: "Bestellstatus zurückgesetzt",  tplEnv: "BREVO_TPL_ORDERED_OFF"   },
  },
  ready: {
    on:  { label: "Bestellung abholbereit",       tplEnv: "BREVO_TPL_READY_ON"      },
    off: { label: "Abholstatus zurückgesetzt",    tplEnv: "BREVO_TPL_READY_OFF"     },
  },
  delivered: {
    on:  { label: "Bestellung ausgeliefert",      tplEnv: "BREVO_TPL_DELIVERED_ON"  },
    off: { label: "Auslieferung zurückgesetzt",   tplEnv: "BREVO_TPL_DELIVERED_OFF" },
  },
};

export default async function handler(req, res) {
  // CORS
  const allowed = process.env.ALLOWED_ORIGIN || "";
  res.setHeader("Access-Control-Allow-Origin", allowed || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Auth bei jedem Request prüfen
  if (!checkAuth(req)) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
    return res.status(401).json({ error: "Unauthorized" });
  }

  const url    = SUPABASE_URL();
  const key    = SUPABASE_KEY();
  const action = req.query.action;

  // ── GET orders (aktiv oder archiviert) ─────────────────────────────────
  if (req.method === "GET" && action === "orders") {
    const archived = req.query.archived === "true";
    const r = await fetch(
      `${url}/rest/v1/orders?select=*&archived=eq.${archived}&order=created_at.desc`,
      { headers: { "apikey": key, "Authorization": `Bearer ${key}` } }
    );
    if (!r.ok) return res.status(500).json({ error: "DB-Fehler" });
    return res.status(200).json(await r.json());
  }

  // ── PATCH status – togglet einen Statuswert und sendet eigene E-Mail ───
  if (req.method === "PATCH" && action === "status") {
    const { id, field, value, order } = req.body || {};
    const allowed_fields = ["paid", "ordered", "delivered", "ready"];
    if (!id || !allowed_fields.includes(field)) {
      return res.status(400).json({ error: "Ungültige Parameter" });
    }

    // In DB speichern
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

    // E-Mail: pro Status + Richtung das passende Template holen
    if (order && order.customer_email) {
      const direction = value ? "on" : "off";
      const cfg       = STATUS_CONFIG[field]?.[direction];

      if (cfg) {
        const templateId = process.env[cfg.tplEnv]; // z.B. process.env.BREVO_TPL_READY_ON
        await sendBrevoEmail(
          order.customer_email,
          order.customer_name || "Kunde",
          templateId,
          {
            customer_name: order.customer_name,
            order_id:      order.order_id,
            product_name:  order.product_name,
            size:          order.size,
            color:         order.color,
            gender:        order.gender,
            class_level:   order.class_level,
            class_letter:  order.class_letter,
            note:          order.note || "—",
            status_label:  cfg.label,
          }
        );
      }
    }

    return res.status(200).json({ ok: true });
  }

  // ── PATCH archive – archiviert oder reaktiviert eine Bestellung ─────────
  if (req.method === "PATCH" && action === "archive") {
    const { id, archived } = req.body || {};
    if (!id) return res.status(400).json({ error: "Keine ID" });

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
        body: JSON.stringify({ archived: !!archived }),
      }
    );
    if (!r.ok) return res.status(500).json({ error: "Archivierung fehlgeschlagen" });
    return res.status(200).json({ ok: true });
  }

  // ── PATCH archive-bulk – archiviert mehrere Bestellungen auf einmal ─────
  if (req.method === "PATCH" && action === "archive-bulk") {
    const { ids, archived } = req.body || {};
    if (!ids || !ids.length) return res.status(400).json({ error: "Keine IDs" });

    const idList = ids.map(i => `"${i}"`).join(",");
    const r = await fetch(
      `${url}/rest/v1/orders?id=in.(${idList})`,
      {
        method: "PATCH",
        headers: {
          "apikey":        key,
          "Authorization": `Bearer ${key}`,
          "Content-Type":  "application/json",
          "Prefer":        "return=minimal",
        },
        body: JSON.stringify({ archived: !!archived }),
      }
    );
    if (!r.ok) return res.status(500).json({ error: "Bulk-Archivierung fehlgeschlagen" });
    return res.status(200).json({ ok: true });
  }

  return res.status(404).json({ error: "Route not found" });
}
