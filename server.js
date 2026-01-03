// server.js
// ==== JDR Backend (PNJ Postgres + Engine) ====
// Fixes:
// 1) Engine/context: PNJs uniquement via allowlist pnjIds (sinon scene vide)
// 2) Refresh: refreshAllSessions() après toute écriture (pnj patch/bulk/commit)
// 3) Edition sans contrainte: adminOverride par défaut TRUE, lockedTraits non bloquant
// 4) Bulk patch stable + intelligent merge

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));

// ----------------- Postgres -----------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
});

// ---------- Init tables ----------
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pnjs (
        id   TEXT  PRIMARY KEY,
        data JSONB NOT NULL
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS canon_events (
        id   TEXT  PRIMARY KEY,
        data JSONB NOT NULL
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS locations (
        id   TEXT  PRIMARY KEY,
        data JSONB NOT NULL
      );
    `);

    console.log("✅ Tables OK");
  } catch (e) {
    console.error("❌ Init tables error", e);
  }
})();

// ----------------- Utils -----------------
function normalizeText(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/** Deep merge JSON (objets récursifs, arrays overwrite) */
function deepMerge(target, source) {
  if (!source || typeof source !== "object") return target;
  if (!target || typeof target !== "object") return source;

  const out = Array.isArray(target) ? [...target] : { ...target };

  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Edition sans contrainte :
 * - On conserve la signature (pour compat) mais on ne bloque jamais.
 * - lockedTraitsIgnored est toujours [].
 */
function stripLockedPatch(_current, patch, _adminOverride = true) {
  return { patch: patch || {}, locked: [] };
}

function normalizePnjPatchForEngine(patch) {
  if (!patch || typeof patch !== "object") return {};
  const out = { ...patch };

  // UI: "race" => "raceName"
  if (typeof out.race === "string" && out.race.trim()) {
    out.raceName = out.race.trim();
    delete out.race;
  }
  // stats.race -> raceName
  if (out.stats && typeof out.stats === "object") {
    const sr = out.stats.race;
    if (typeof sr === "string" && sr.trim()) out.raceName = sr.trim();
  }

  // Safety: jamais via patch
  if ("id" in out) delete out.id;
  if ("adminOverride" in out) delete out.adminOverride;
  if ("ids" in out) delete out.ids;
  if ("dryRun" in out) delete out.dryRun;
  if ("patch" in out) delete out.patch;

  return out;
}

/**
 * Optionnel : range certains champs “mal placés” dans stats (si tu l’utilises dans tes fiches).
 * Tu peux étendre cette liste si tu veux.
 */
function moveMisplacedFieldsIntoStats(base, patch) {
  const nestedFix = { ...patch };
  const keysToStats = ["statut", "royaume", "compétence ultime"]; // volontairement exclut "race"

  for (const key of keysToStats) {
    if (nestedFix[key] != null && nestedFix[key] !== "") {
      base.stats = { ...(base.stats || {}) };
      base.stats[key] = nestedFix[key];
      delete nestedFix[key];
    }
  }

  return { base, nestedFix };
}

function continuityDossier(p) {
  return {
    id: p.id,
    name: p.name,
    coreFacts: [
      (p.raceName || p.raceId || p.race || p?.stats?.race)
        ? `Race: ${p.raceName || p.raceId || p.race || p?.stats?.race}`
        : null,
      Array.isArray(p.personalityTraits) && p.personalityTraits.length
        ? `Traits: ${p.personalityTraits.slice(0, 5).join(", ")}`
        : null,
      p.locationId ? `Loc: ${p.locationId}` : null,
      p?.canon?.status ? `Canon: ${p.canon.status}` : null,
    ].filter(Boolean),
  };
}

// ----------------- DB loaders -----------------
async function loadAllPnjs() {
  const r = await pool.query("SELECT id, data FROM pnjs");
  return r.rows.map((row) => ({ id: row.id, ...(row.data || {}) }));
}
async function loadAllLocations() {
  const r = await pool.query("SELECT id, data FROM locations");
  return r.rows.map((row) => ({ id: row.id, ...(row.data || {}) }));
}
async function loadAllCanonEvents() {
  const r = await pool.query("SELECT id, data FROM canon_events");
  return r.rows.map((row) => ({ id: row.id, ...(row.data || {}) }));
}

// ----------------- Memory Sessions (Engine) -----------------
const sessions = new Map();

function getSession(sid = "default") {
  if (!sessions.has(sid)) {
    sessions.set(sid, {
      sid,
      createdAt: Date.now(),
      data: {
        dossiersById: {},
        lastContext: null,
        lastRefreshAt: null,
      },
    });
  }
  return sessions.get(sid);
}

async function refreshEngine(sid = "default") {
  const sess = getSession(sid);

  const [pnjs, locations, canonEvents] = await Promise.all([
    loadAllPnjs(),
    loadAllLocations(),
    loadAllCanonEvents(),
  ]);

  const dossiersById = {};
  for (const p of pnjs) dossiersById[p.id] = continuityDossier(p);

  sess.data.dossiersById = dossiersById;
  sess.data.lastRefreshAt = Date.now();
  sess.data.lastContext = { pnjs, locations, canonEvents };

  return {
    sid,
    refreshedAt: sess.data.lastRefreshAt,
    counts: {
      pnjs: pnjs.length,
      locations: locations.length,
      canonEvents: canonEvents.length,
    },
    sampleDossiers: Object.values(dossiersById).slice(0, 5),
  };
}

async function refreshAllSessions() {
  const sids = Array.from(sessions.keys());
  if (sids.length === 0) return;
  await Promise.allSettled(sids.map((sid) => refreshEngine(sid)));
}

// ----------------- Health -----------------
app.get("/health", (_req, res) => res.json({ ok: true }));

// ----------------- PNJ CRUD -----------------

// LIST
app.get("/api/pnjs", async (_req, res) => {
  try {
    const result = await pool.query("SELECT id, data FROM pnjs ORDER BY id");
    res.json({
      ok: true,
      pnjs: result.rows.map((r) => ({ id: r.id, ...(r.data || {}) })),
    });
  } catch (err) {
    console.error("[GET PNJS]", err);
    res.status(500).json({
      ok: false,
      message: "Erreur serveur lors de la récupération des PNJs",
      error: err.message,
    });
  }
});

// SEARCH
app.get("/api/pnjs/search", async (req, res) => {
  try {
    const q = normalizeText(req.query.q || "");
    if (!q) return res.json({ ok: true, results: [] });

    const result = await pool.query("SELECT id, data FROM pnjs");
    const all = result.rows.map((r) => ({ id: r.id, ...(r.data || {}) }));

    const hits = all
      .map((p) => {
        const name = normalizeText(p.name);
        const race = normalizeText(p.raceName || p.raceId || p.race || p?.stats?.race);
        const traits = Array.isArray(p.personalityTraits)
          ? p.personalityTraits.map(normalizeText).join(" ")
          : "";
        const blob = `${name} ${race} ${traits}`;
        const score = blob.includes(q) ? q.length / Math.max(1, blob.length) : 0;
        return { p, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map((x) => ({
        id: x.p.id,
        name: x.p.name,
        race: x.p.raceName || x.p.raceId || x.p.race || x.p?.stats?.race || null,
      }));

    res.json({ ok: true, results: hits });
  } catch (err) {
    console.error("[SEARCH PNJ ERROR]", err);
    res.status(500).json({ ok: false, message: "Erreur serveur lors de la recherche PNJ" });
  }
});

// GET BY ID
app.get("/api/pnjs/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("SELECT data FROM pnjs WHERE id = $1", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, message: `PNJ ${id} introuvable` });
    }
    res.json({ ok: true, id, data: result.rows[0].data });
  } catch (err) {
    console.error("[GET PNJ BY ID]", err);
    res.status(500).json({
      ok: false,
      message: "Erreur serveur lors de la récupération du PNJ",
      error: err.message,
    });
  }
});

// PATCH BY ID (édition sans contrainte)
app.patch("/api/pnjs/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const body = req.body && typeof req.body === "object" ? req.body : {};

    // Supporte 2 formats:
    // A) flat:  { ...champs }
    // B) wrap:  { patch: { ...champs } }
    // adminOverride est accepté mais par défaut TRUE (édition sans contrainte).
    const isAdminOverride = body.adminOverride !== false; // default true
    let patch = body.patch && typeof body.patch === "object" ? body.patch : body;

    // ne jamais autoriser id/adminOverride dans la data
    if (patch && typeof patch === "object") {
      if ("id" in patch) delete patch.id;
      if ("adminOverride" in patch) delete patch.adminOverride;
      if ("patch" in patch) delete patch.patch;
    }

    if (!patch || typeof patch !== "object" || Object.keys(patch).length === 0) {
      return res.status(400).json({ ok: false, message: "Aucune donnée à modifier." });
    }

    const existing = await pool.query("SELECT data FROM pnjs WHERE id = $1", [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ ok: false, message: `PNJ ${id} introuvable.` });
    }

    const currentData = existing.rows[0].data || {};

    const stripped = stripLockedPatch(currentData, patch, isAdminOverride);
    const cleanedPatchRaw = stripped?.patch || {};
    const locked = stripped?.locked || [];

    const cleanedPatch = normalizePnjPatchForEngine(cleanedPatchRaw);

    // Base clone + stats merge
    let base = { ...currentData, stats: { ...(currentData.stats || {}) } };
    const moved = moveMisplacedFieldsIntoStats(base, cleanedPatch);
    base = moved.base;
    const nestedFix = moved.nestedFix;

    const mergedData = deepMerge(base, nestedFix);

    const updateQuery = `
      UPDATE pnjs
      SET data = jsonb_strip_nulls($1::jsonb)
      WHERE id = $2
      RETURNING data;
    `;
    const result = await pool.query(updateQuery, [JSON.stringify(mergedData), id]);

    // ✅ refresh toutes sessions
    await refreshAllSessions();

    res.json({
      ok: true,
      id,
      message: "✅ PNJ mis à jour avec succès (intelligent merge).",
      lockedTraitsIgnored: locked,
      data: result.rows[0].data,
    });
  } catch (err) {
    console.error("[PATCH PNJ]", err);
    res.status(500).json({ ok: false, message: err.message });
  }
});
// ✅ PUT BULK FULL REPLACE (remplace entièrement plusieurs fiches)
// ⚠️ doit être déclaré AVANT /api/pnjs/:id
app.put("/api/pnjs/bulk", async (req, res) => {
  try {
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : []; // [{id, data}, ...]
    if (!items.length) return res.status(400).json({ ok: false, message: "items requis" });

    const results = [];
    for (const it of items) {
      const id = String(it.id || "").trim();
      const data = it.data && typeof it.data === "object" ? it.data : null;
      if (!id || !data) {
        results.push({ id: id || null, ok: false, error: "Missing id/data" });
        continue;
      }
      if ("id" in data) delete data.id;

      const existing = await pool.query("SELECT 1 FROM pnjs WHERE id = $1", [id]);
      if (existing.rows.length === 0) {
        results.push({ id, ok: false, error: "PNJ introuvable" });
        continue;
      }

      await pool.query(
        "UPDATE pnjs SET data = jsonb_strip_nulls($1::jsonb) WHERE id = $2",
        [JSON.stringify(data), id]
      );

      results.push({ id, ok: true });
    }

    await refreshAllSessions();
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ✅ PUT FULL REPLACE (remplace data entièrement)
app.put("/api/pnjs/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const data = body.data && typeof body.data === "object" ? body.data : body; // accepte {data:{...}} ou direct

    if (!data || typeof data !== "object" || Object.keys(data).length === 0) {
      return res.status(400).json({ ok: false, message: "data requis (objet non vide)" });
    }

    const existing = await pool.query("SELECT data FROM pnjs WHERE id = $1", [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ ok: false, message: `PNJ ${id} introuvable.` });
    }

    if ("id" in data) delete data.id;

    const result = await pool.query(
      "UPDATE pnjs SET data = jsonb_strip_nulls($1::jsonb) WHERE id = $2 RETURNING data",
      [JSON.stringify(data), id]
    );

    await refreshAllSessions();

    res.json({
      ok: true,
      id,
      message: "✅ PNJ remplacé entièrement (full replace).",
      data: result.rows[0].data,
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// BULK PATCH (modifier plusieurs fiches)
app.patch("/api/pnjs/bulk", async (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const ids = Array.isArray(body.ids) ? body.ids.map((x) => String(x).trim()).filter(Boolean) : [];

    // adminOverride default TRUE (édition sans contrainte)
    const isAdminOverride = body.adminOverride !== false;
    const dryRun = body.dryRun === true;

    let patch = body.patch && typeof body.patch === "object" ? body.patch : body;

    // Retire meta-champs si le user a envoyé "direct"
    if (patch && typeof patch === "object") {
      delete patch.ids;
      delete patch.adminOverride;
      delete patch.dryRun;
    }

    if (!ids.length) return res.status(400).json({ ok: false, message: "ids[] requis (au moins 1)." });
    if (!patch || typeof patch !== "object" || Object.keys(patch).length === 0) {
      return res.status(400).json({ ok: false, message: "patch requis (objet non vide)." });
    }

    const MAX_BULK = 300;
    if (ids.length > MAX_BULK) {
      return res.status(400).json({ ok: false, message: `Trop d'ids (${ids.length}). Max=${MAX_BULK}` });
    }

    const results = [];
    const cleanedPatch = normalizePnjPatchForEngine(patch);

    for (const id of ids) {
      try {
        const existing = await pool.query("SELECT data FROM pnjs WHERE id = $1", [id]);
        if (existing.rows.length === 0) {
          results.push({ id, ok: false, error: "PNJ introuvable" });
          continue;
        }

        const currentData = existing.rows[0].data || {};
        const stripped = stripLockedPatch(currentData, cleanedPatch, isAdminOverride);
        const patchRaw = stripped?.patch || {};
        const locked = stripped?.locked || [];

        if (!patchRaw || typeof patchRaw !== "object" || Object.keys(patchRaw).length === 0) {
          results.push({ id, ok: false, error: "Patch vide", lockedTraitsIgnored: locked });
          continue;
        }

        let base = { ...currentData, stats: { ...(currentData.stats || {}) } };
        const moved = moveMisplacedFieldsIntoStats(base, patchRaw);
        base = moved.base;
        const nestedFix = moved.nestedFix;

        const mergedData = deepMerge(base, nestedFix);

        if (!dryRun) {
          await pool.query("UPDATE pnjs SET data = jsonb_strip_nulls($1::jsonb) WHERE id = $2", [
            JSON.stringify(mergedData),
            id,
          ]);
        }

        results.push({
          id,
          ok: true,
          dryRun,
          lockedTraitsIgnored: locked,
          updatedKeys: Object.keys(patchRaw),
        });
      } catch (e) {
        results.push({ id, ok: false, error: String(e?.message || e) });
      }
    }

    if (!dryRun) {
      await refreshAllSessions();
    }

    res.json({
      ok: true,
      dryRun,
      requested: ids.length,
      updated: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    });
  } catch (err) {
    console.error("[PATCH PNJ BULK]", err);
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ----------------- Locations -----------------
app.get("/api/locations", async (_req, res) => {
  try {
    const result = await pool.query("SELECT id, data FROM locations ORDER BY id");
    res.json({
      ok: true,
      locations: result.rows.map((r) => ({ id: r.id, ...(r.data || {}) })),
    });
  } catch (err) {
    console.error("[GET LOCATIONS]", err);
    res.status(500).json({
      ok: false,
      message: "Erreur serveur lors de la récupération des locations",
      error: err.message,
    });
  }
});

// ----------------- Canon Events -----------------
app.get("/api/canon", async (_req, res) => {
  try {
    const result = await pool.query("SELECT id, data FROM canon_events ORDER BY id");
    res.json({
      ok: true,
      canon: result.rows.map((r) => ({ id: r.id, ...(r.data || {}) })),
    });
  } catch (err) {
    console.error("[GET CANON]", err);
    res.status(500).json({
      ok: false,
      message: "Erreur serveur lors de la récupération du canon",
      error: err.message,
    });
  }
});

// ----------------- Engine Refresh -----------------
app.post("/api/engine/refresh", async (req, res) => {
  try {
    const body = req.body || {};
    const sid = String(body.sid || "default");

    const info = await refreshEngine(sid);

    res.json({
      ok: true,
      ...info,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, message: "engine/refresh error", error: e.message });
  }
});

// ----------------- Engine Context -----------------
// IMPORTANT: PNJs uniquement via pnjIds. Si pnjIds absent/vide -> scene.pnjs = []
app.post("/api/engine/context", async (req, res) => {
  try {
    const body = req.body || {};
    const sid = String(body.sid || "default");
    const userText = String(body.userText || "");

    if (!userText.trim()) {
      return res.status(400).json({ ok: false, message: "userText requis." });
    }

    const includeDrafts = body.includeDrafts === true;

    const pnjIds = Array.isArray(body.pnjIds) ? body.pnjIds.map(String) : [];
    const locationIds = Array.isArray(body.locationIds) ? body.locationIds.map(String) : [];

    const sess = getSession(sid);

    // auto refresh si pas de données
    if (!sess.data.lastContext) {
      await refreshEngine(sid);
    }

    const { pnjs, locations, canonEvents } = sess.data.lastContext;

    // ✅ Allowlist stricte
    let pnjsInScene = [];
    if (pnjIds.length) {
      pnjsInScene = pnjs.filter((p) => pnjIds.includes(p.id));
    }

    // Draft filtering (par défaut, un PNJ sans canon.status n'est PAS draft)
    if (!includeDrafts) {
      pnjsInScene = pnjsInScene.filter((p) => (p?.canon?.status || "canon") !== "draft");
    }

    // Filtre locations en scène
    let locationsInScene = locations;
    if (locationIds.length) locationsInScene = locationsInScene.filter((l) => locationIds.includes(l.id));

    const pnjDetails = pnjsInScene.slice(0, 50).map((p) => ({
      id: p.id,
      name: p.name,
      appearance: p.appearance ?? null,
      personalityTraits: Array.isArray(p.personalityTraits) ? p.personalityTraits : [],
      backstory: p.backstory ?? "",
      raceName: p.raceName || p.raceId || p.race || p?.stats?.race || null,
      relations: p.relations || p.relationships || null,
      locationId: p.locationId ?? null,
      lockedTraits: Array.isArray(p.lockedTraits) ? p.lockedTraits : [],
      canon: p.canon || { status: "canon" },
      skills: Array.isArray(p.skills) ? p.skills : [],
      magics: Array.isArray(p.magics) ? p.magics : [],
      weaponTechniques: Array.isArray(p.weaponTechniques) ? p.weaponTechniques : [],
      transformations: Array.isArray(p.transformations) ? p.transformations : [],
      activeTransformation: p.activeTransformation ?? null,
    }));

    const locDetails = locationsInScene.slice(0, 50).map((l) => ({
      id: l.id,
      name: l.name,
      description: l.description ?? "",
      tags: Array.isArray(l.tags) ? l.tags : [],
      canon: l.canon || { status: "canon" },
    }));

    const canonInScene = canonEvents
      .filter((e) => (includeDrafts ? true : (e?.canon?.status || "canon") !== "draft"))
      .slice(0, 100)
      .map((e) => ({
        id: e.id,
        name: e.name,
        summary: e.summary ?? "",
        time: e.time ?? null,
        canon: e.canon || { status: "canon" },
      }));

    res.json({
      ok: true,
      sid,
      userText,
      scene: {
        pnjs: pnjDetails,
        locations: locDetails,
        canonEvents: canonInScene,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, message: "engine/context error", error: e.message });
  }
});

// ----------------- Engine Commit -----------------
// Ici aussi: adminOverride default TRUE, et commit peut modifier durablement (pas de blocage name/race/canon)
app.post("/api/engine/commit", async (req, res) => {
  try {
    const body = req.body || {};
    const sid = String(body.sid || "default");
    const updates = Array.isArray(body.updates) ? body.updates : [];

    if (!updates.length) {
      return res.status(400).json({ ok: false, message: "updates[] requis (au moins 1)." });
    }

    const results = [];

    for (const upd of updates) {
      const id = String(upd.id || "").trim();
      const patch0 = upd.patch && typeof upd.patch === "object" ? upd.patch : null;

      // adminOverride default TRUE
      const isAdminOverride = upd.adminOverride !== false;

      if (!id || !patch0) {
        results.push({ id: id || null, ok: false, error: "Missing id/patch" });
        continue;
      }

      const existing = await pool.query("SELECT data FROM pnjs WHERE id = $1", [id]);
      if (existing.rows.length === 0) {
        results.push({ id, ok: false, error: "PNJ introuvable" });
        continue;
      }

      const currentData = existing.rows[0].data || {};
      const stripped = stripLockedPatch(currentData, patch0, isAdminOverride);
      const cleanedPatchRaw = stripped?.patch || {};
      const locked = stripped?.locked || [];

      const cleanedPatch = normalizePnjPatchForEngine(cleanedPatchRaw);

      if (!cleanedPatch || typeof cleanedPatch !== "object" || Object.keys(cleanedPatch).length === 0) {
        results.push({ id, ok: false, error: "Patch vide", lockedTraitsIgnored: locked });
        continue;
      }

      let base = { ...currentData, stats: { ...(currentData.stats || {}) } };
      const moved = moveMisplacedFieldsIntoStats(base, cleanedPatch);
      base = moved.base;
      const nestedFix = moved.nestedFix;

      const mergedData = deepMerge(base, nestedFix);

      await pool.query("UPDATE pnjs SET data = jsonb_strip_nulls($1::jsonb) WHERE id = $2", [
        JSON.stringify(mergedData),
        id,
      ]);

      results.push({ id, ok: true, lockedTraitsIgnored: locked, updatedKeys: Object.keys(cleanedPatch) });
    }

    await refreshAllSessions();

    res.json({ ok: true, sid, results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, message: "engine/commit error", error: e.message });
  }
});

// ----------------- Server -----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ JDR API en ligne sur http://localhost:${PORT}`);
});

