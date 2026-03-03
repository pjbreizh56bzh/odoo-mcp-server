const https = require("https");
const http = require("http");
const { URL } = require("url");

// ─── HTTP POST ───────────────────────────────────────────────────────────────

function post(urlStr, body, ct) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "https:" ? https : http;
    const buf = Buffer.from(body, "utf8");
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname, method: "POST",
      headers: { "Content-Type": ct, "Content-Length": buf.length }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(buf); req.end();
  });
}

// ─── XML-RPC Parser correct ──────────────────────────────────────────────────

// Find content between first matching open/close tag pair
function getTag(xml, tag) {
  const open = xml.indexOf(`<${tag}`);
  if (open === -1) return null;
  const contentStart = xml.indexOf(">", open) + 1;
  const close = `</${tag}>`;
  // Find closing tag, counting nesting
  let depth = 1, pos = contentStart;
  while (depth > 0) {
    const nextOpen = xml.indexOf(`<${tag}`, pos);
    const nextClose = xml.indexOf(close, pos);
    if (nextClose === -1) return null;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      pos = nextOpen + tag.length + 2;
    } else {
      depth--;
      if (depth === 0) return xml.slice(contentStart, nextClose);
      pos = nextClose + close.length;
    }
  }
  return null;
}

// Get all <tag>...</tag> occurrences (non-nested)
function getAllTags(xml, tag) {
  const results = [];
  let pos = 0;
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  while (true) {
    const start = xml.indexOf(open, pos);
    if (start === -1) break;
    const end = xml.indexOf(close, start);
    if (end === -1) break;
    results.push(xml.slice(start + open.length, end));
    pos = end + close.length;
  }
  return results;
}

function parseValue(xml) {
  xml = xml.trim();
  // Strip outer <value>...</value> if present
  if (xml.startsWith("<value>") || xml.startsWith("<value ")) {
    const inner = getTag(xml, "value");
    if (inner !== null) return parseValue(inner);
  }

  // int / i4 / i8
  const intM = xml.match(/^<i[48]?>(-?\d+)<\/i[48]?>$/) || xml.match(/^<int>(-?\d+)<\/int>$/);
  if (intM) return parseInt(intM[1], 10);

  // double
  const dblM = xml.match(/^<double>([\d.eE+\-]+)<\/double>$/);
  if (dblM) return parseFloat(dblM[1]);

  // boolean
  const boolM = xml.match(/^<boolean>([01])<\/boolean>$/);
  if (boolM) return boolM[1] === "1";

  // string
  if (xml.startsWith("<string>") && xml.endsWith("</string>")) {
    return xml.slice(8, -9).replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&apos;/g,"'").replace(/&quot;/g,'"');
  }

  // nil / base64 treat as string
  if (xml === "<nil/>" || xml === "<nil />") return null;
  if (xml.startsWith("<base64>")) return xml.slice(8, xml.indexOf("</base64>"));

  // array
  if (xml.includes("<array>")) {
    const data = getTag(xml, "data");
    if (data === null) return [];
    // Parse each <value> in data
    const items = [];
    let pos = 0;
    while (true) {
      const start = data.indexOf("<value>", pos);
      if (start === -1) break;
      const inner = getTag(data.slice(start), "value");
      if (inner === null) break;
      items.push(parseValue(inner));
      // advance past this value tag
      const end = data.indexOf("</value>", start);
      pos = end + 8;
    }
    return items;
  }

  // struct
  if (xml.includes("<struct>")) {
    const struct = getTag(xml, "struct");
    if (struct === null) return {};
    const obj = {};
    let pos = 0;
    while (true) {
      const mStart = struct.indexOf("<member>", pos);
      if (mStart === -1) break;
      const mEnd = struct.indexOf("</member>", mStart);
      if (mEnd === -1) break;
      const member = struct.slice(mStart + 8, mEnd);
      const nameContent = getTag(member, "name");
      const valContent = getTag(member, "value");
      if (nameContent !== null && valContent !== null) {
        obj[nameContent.trim()] = parseValue(valContent);
      }
      pos = mEnd + 9;
    }
    return obj;
  }

  // Plain text (no tags) - treat as string
  const stripped = xml.replace(/<[^>]+>/g, "").trim();
  return stripped || null;
}

function parseXmlRpcResponse(xml) {
  if (xml.includes("<fault>")) {
    const faultXml = getTag(xml, "fault");
    const fault = parseValue(faultXml || "");
    throw new Error("Odoo Fault: " + (fault && fault.faultString ? fault.faultString : JSON.stringify(fault)));
  }
  const paramsXml = getTag(xml, "params");
  if (!paramsXml) throw new Error("Réponse XML-RPC invalide:\n" + xml.slice(0, 500));
  const paramXml = getTag(paramsXml, "param");
  const valueXml = getTag(paramXml || paramsXml, "value");
  return parseValue(valueXml || paramXml || paramsXml);
}

// ─── XML-RPC Builder ─────────────────────────────────────────────────────────

function v(val) {
  if (val === null || val === undefined) return "<value><nil/></value>";
  if (typeof val === "boolean") return `<value><boolean>${val ? 1 : 0}</boolean></value>`;
  if (typeof val === "number") return Number.isInteger(val) ? `<value><int>${val}</int></value>` : `<value><double>${val}</double></value>`;
  if (typeof val === "string") return `<value><string>${val.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</string></value>`;
  if (Array.isArray(val)) return `<value><array><data>${val.map(v).join("")}</data></array></value>`;
  if (typeof val === "object") {
    const m = Object.entries(val).map(([k,vv]) => `<member><name>${k}</name>${v(vv)}</member>`).join("");
    return `<value><struct>${m}</struct></value>`;
  }
  return `<value><string>${String(val)}</string></value>`;
}

function buildCall(method, params) {
  return `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${params.map(p => `<param>${v(p)}</param>`).join("")}</params></methodCall>`;
}

// ─── Odoo XML-RPC ────────────────────────────────────────────────────────────

function getCfg() {
  const url = process.env.ODOO_URL;
  const db = process.env.ODOO_DATABASE;
  const login = process.env.ODOO_USERNAME;
  const apiKey = process.env.ODOO_API_KEY || process.env.ODOO_PASSWORD;
  if (!url || !db || !login || !apiKey) throw new Error("Config manquante: ODOO_URL, ODOO_DATABASE, ODOO_USERNAME, ODOO_API_KEY");
  return { url: url.replace(/\/$/, ""), db, login, apiKey };
}

async function xmlrpc(url, path, method, params) {
  const xml = await post(url + path, buildCall(method, params), "text/xml; charset=utf-8");
  return parseXmlRpcResponse(xml);
}

async function getUid(cfg) {
  const uid = await xmlrpc(cfg.url, "/xmlrpc/2/common", "authenticate", [cfg.db, cfg.login, cfg.apiKey, {}]);
  if (!uid) throw new Error("Auth Odoo échouée. Vérifiez ODOO_USERNAME et ODOO_API_KEY.");
  return uid;
}

async function exec(cfg, uid, model, method, args, kwargs) {
  return xmlrpc(cfg.url, "/xmlrpc/2/object", "execute_kw", [
    cfg.db, uid, cfg.apiKey, model, method, args || [], kwargs || {}
  ]);
}

// ─── MCP Tools ───────────────────────────────────────────────────────────────

const TOOLS = [
  { name: "odoo_search_read", description: "Recherche et lit des enregistrements dans n'importe quel modèle Odoo (res.partner, account.move, sale.order, project.task, etc.)",
    inputSchema: { type: "object", properties: {
      model: { type: "string" }, domain: { type: "array", items: { type: "array" }, default: [] },
      fields: { type: "array", items: { type: "string" }, default: [] },
      limit: { type: "number", default: 20 }, offset: { type: "number", default: 0 }, order: { type: "string", default: "id desc" }
    }, required: ["model"] }},
  { name: "odoo_read_record", description: "Lit un ou plusieurs enregistrements Odoo par leurs IDs",
    inputSchema: { type: "object", properties: {
      model: { type: "string" }, ids: { type: "array", items: { type: "number" } }, fields: { type: "array", items: { type: "string" }, default: [] }
    }, required: ["model", "ids"] }},
  { name: "odoo_get_fields", description: "Retourne la définition des champs d'un modèle Odoo",
    inputSchema: { type: "object", properties: { model: { type: "string" }, filter_type: { type: "string" } }, required: ["model"] }},
  { name: "odoo_list_models", description: "Liste tous les modèles disponibles dans l'instance Odoo",
    inputSchema: { type: "object", properties: { search: { type: "string" } } }},
  { name: "odoo_create_record", description: "Crée un nouvel enregistrement dans un modèle Odoo (contact, facture, tâche, etc.)",
    inputSchema: { type: "object", properties: { model: { type: "string" }, values: { type: "object" } }, required: ["model", "values"] }},
  { name: "odoo_update_record", description: "Met à jour des enregistrements existants dans Odoo",
    inputSchema: { type: "object", properties: {
      model: { type: "string" }, ids: { type: "array", items: { type: "number" } }, values: { type: "object" }
    }, required: ["model", "ids", "values"] }},
  { name: "odoo_delete_record", description: "Supprime des enregistrements Odoo par leurs IDs (ATTENTION: irréversible)",
    inputSchema: { type: "object", properties: { model: { type: "string" }, ids: { type: "array", items: { type: "number" } } }, required: ["model", "ids"] }},
  { name: "odoo_execute_method", description: "Exécute une méthode Odoo (ex: action_confirm, action_post, action_cancel)",
    inputSchema: { type: "object", properties: {
      model: { type: "string" }, ids: { type: "array", items: { type: "number" }, default: [] },
      method: { type: "string" }, kwargs: { type: "object", default: {} }
    }, required: ["model", "method"] }}
];

async function executeTool(name, args) {
  const cfg = getCfg();
  const uid = await getUid(cfg);

  switch (name) {
    case "odoo_search_read": {
      const { model, domain=[], fields=[], limit=20, offset=0, order="id desc" } = args;
      const records = await exec(cfg, uid, model, "search_read", [domain], { fields, limit, offset, order });
      const total = await exec(cfg, uid, model, "search_count", [domain]);
      return { model, total, count: Array.isArray(records) ? records.length : 0, records: records || [] };
    }
    case "odoo_read_record": {
      const records = await exec(cfg, uid, args.model, "read", [args.ids], { fields: args.fields || [] });
      return { model: args.model, records: records || [] };
    }
    case "odoo_get_fields": {
      const fields = await exec(cfg, uid, args.model, "fields_get", [], { attributes: ["string","type","required"] });
      let result = fields || {};
      if (args.filter_type) result = Object.fromEntries(Object.entries(result).filter(([,v]) => v.type === args.filter_type));
      return { model: args.model, field_count: Object.keys(result).length, fields: Object.fromEntries(Object.entries(result).slice(0,80)) };
    }
    case "odoo_list_models": {
      const domain = args.search ? [["model","like",args.search]] : [];
      const models = await exec(cfg, uid, "ir.model", "search_read", [domain], { fields: ["name","model"], limit: 100, order: "model asc" });
      return { count: Array.isArray(models) ? models.length : 0, models: models || [] };
    }
    case "odoo_create_record": {
      const id = await exec(cfg, uid, args.model, "create", [args.values]);
      return { success: true, model: args.model, new_id: id };
    }
    case "odoo_update_record": {
      const ok = await exec(cfg, uid, args.model, "write", [args.ids, args.values]);
      return { success: ok, model: args.model, updated_ids: args.ids };
    }
    case "odoo_delete_record": {
      const ok = await exec(cfg, uid, args.model, "unlink", [args.ids]);
      return { success: ok, model: args.model, deleted_ids: args.ids };
    }
    case "odoo_execute_method": {
      const { model, ids=[], method, kwargs={} } = args;
      const result = await exec(cfg, uid, model, method, ids.length ? [ids] : [], kwargs);
      return { success: true, model, method, result };
    }
    default: throw new Error("Outil inconnu: " + name);
  }
}

// ─── Netlify Handler ─────────────────────────────────────────────────────────

exports.handler = async function(event) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept"
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod === "GET") return { statusCode: 200, headers, body: JSON.stringify({ name: "odoo-mcp-server", version: "1.0.0" }) };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { id, method, params } = body;

  try {
    let result;
    if (method === "initialize") {
      result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "odoo-mcp-server", version: "1.0.0" } };
    } else if (method === "notifications/initialized" || method === "ping") {
      result = {};
    } else if (method === "tools/list") {
      result = { tools: TOOLS };
    } else if (method === "tools/call") {
      try {
        const toolResult = await executeTool(params.name, params.arguments || {});
        result = { content: [{ type: "text", text: JSON.stringify(toolResult, null, 2) }] };
      } catch (e) {
        result = { content: [{ type: "text", text: "Erreur: " + e.message }], isError: true };
      }
    } else {
      return { statusCode: 200, headers, body: JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Méthode inconnue: " + method } }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ jsonrpc: "2.0", id, result }) };
  } catch (err) {
    return { statusCode: 200, headers, body: JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: err.message } }) };
  }
};
