// api/order.js  – Vercel Serverless Function
// Alle geheimen Keys bleiben hier auf dem Server. Der Browser sieht sie NIE.

export default async function handler(req, res) {
  // Nur POST erlaubt
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // CORS – nur von der eigenen Domain erlauben
  const origin = req.headers.origin || "";
  const allowed = process.env.ALLOWED_ORIGIN || "";
  if (allowed && origin !== allowed) {
    return res.status(403).json({ error: "Forbidden" });
  }
  res.setHeader("Access-Control-Allow-Origin", allowed || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Body parsen
  const {
    order_id, product_name, product_price, product_img,
    size, color, gender, class_level, class_letter,
    customer_name, customer_email, note, order_date,
  } = req.body || {};

  // Pflichtfelder prüfen (serverseitig!)
  if (!order_id || !product_name || !size || !color || !gender ||
      !class_level || !class_letter || !customer_name || !customer_email) {
    return res.status(400).json({ error: "Fehlende Pflichtfelder" });
  }

  // E-Mail-Format prüfen
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer_email)) {
    return res.status(400).json({ error: "Ungültige E-Mail-Adresse" });
  }

  const SUPABASE_URL      = process.env.SUPABASE_URL;
  const SUPABASE_KEY      = process.env.SUPABASE_SERVICE_KEY; // Service-Key, nicht Anon-Key!
  const BREVO_API_KEY     = process.env.BREVO_API_KEY;
  const ADMIN_EMAIL       = process.env.ADMIN_EMAIL || "bestellung@merch.st-anna.de";
  const BREVO_ADMIN_TPL   = parseInt(process.env.BREVO_ADMIN_TEMPLATE || "4");
  const BREVO_USER_TPL    = parseInt(process.env.BREVO_USER_TEMPLATE  || "3");

  try {
    // ── 1. Supabase: Bestellung speichern ──────────────────────────────
    const dbRes = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
      method: "POST",
      headers: {
        "apikey":        SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Content-Type":  "application/json",
        "Prefer":        "return=minimal",
      },
      body: JSON.stringify({
        order_id, product_name, product_price, size, color, gender,
        class_level, class_letter, customer_name, customer_email,
        note: note || "—",
      }),
    });

    if (!dbRes.ok) {
      const dbErr = await dbRes.text();
      console.error("Supabase error:", dbErr);
      return res.status(500).json({ error: "Datenbankfehler" });
    }

    // ── 2. Brevo: Admin-Mail ────────────────────────────────────────────
    const emailParams = {
      order_id, product_name, product_price, product_img,
      size, color, gender,
      class_level, class_letter, customer_name, customer_email,
      note: note || "—", order_date,
    };

    await sendBrevoEmail(BREVO_API_KEY, ADMIN_EMAIL, "St. Anna Merch Team",
                         BREVO_ADMIN_TPL, emailParams);

    // ── 3. Brevo: Kunden-Mail ───────────────────────────────────────────
    await sendBrevoEmail(BREVO_API_KEY, customer_email, customer_name,
                         BREVO_USER_TPL, emailParams);

    return res.status(200).json({ ok: true, order_id });

  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Interner Serverfehler" });
  }
}

async function sendBrevoEmail(apiKey, toEmail, toName, templateId, params) {
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "accept":       "application/json",
      "api-key":      apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: [{ email: toEmail, name: toName }],
      templateId,
      params,
      replyTo: { email: params.customer_email },
    }),
  });

  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(`Brevo ${r.status}: ${e.message || r.statusText}`);
  }
  return r.json();
}
