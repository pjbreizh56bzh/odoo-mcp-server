const https = require("https");
const http = require("http");
const { URL } = require("url");

// ─── HTTP POST natif ─────────────────────────────────────────────────────────

function post(urlStr, body, contentType) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === "https:" ? https : http;
    const buf = Buffer.from(body, "utf8");
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": contentType,
        "Content-Length": buf.length
      }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(buf);
    req.end();
  });
}

// ─── XML-RPC (supporte les clés API Odoo) ───────────────────────────────────

function xmlrpcValue(v) {
  if (v === null || v === undefined) return "<value><boolean>0</boolean></value>";
  if (typeof v === "boolean") return `<value><boolean>${v ? 1 : 0}</boolean></value>`;
  if (typeof v === "number") return Number.isInteger(v) ? `<value><int>${v}</int></value>` : `<value><double>${v}</double></value>`;
  if (typeof v === "string") return `<value><string>${v.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</string></value>`;
  if (Array.isArray(v)) return `<value><array><data>${v.map(xmlrpcValue).join("")}</data></array></value>`;
  if (typeof v === "object") {
    const members = Object.entries(v).map(([k,val]) =>
      `<member><name>${k}</name>${xmlrpcValue(val)}</member>`
    ).join("");
    return `<value><struct>${members}</struct></value>`;
  }
  return `<value><string>${String(v)}</string></value>`;
}

function buildXmlRpc(method, params) {
  const paramXml = params.map(p => `<param>${xmlrpcValue(p)}</param>`).join("");
  return `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${paramXml}</params></methodCall>`;
}

function parseXmlRpcValue(node) {
  // Simple parser for Odoo XML-RPC responses
  // Extract int
  const intM = node.match(/<int>(-?\d+)<\/int>/);
  if (intM) return parseInt(intM[1]);
  const i4M = node.match(/<i4>(-?\d+)<\/i4>/);
  if (i4M) return parseInt(i4M[1]);
  const dblM = node.match(/<double>([\d.e+-]+)<\/double>/);
  if (dblM) return parseFloat(dblM[1]);
  const boolM = node.match(/<boolean>([01])<\/boolean>/);
  if (boolM) return boolM[1] === "1";
  const strM = node.match(/<string>([\s\S]*?)<\/string>/);
  if (strM) return strM[1].replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">");
  if (node.includes("<nil/>") || node.includes("<nil />")) return null;
  
  // Array
  const arrayM = node.match(/<array>\s*<data>([\s\S]*?)<\/data>\s*<\/array>/);
  if (arrayM) {
    const items = [];
    const content = arrayM[1];
    const valueRe = /<value>([\s\S]*?)<\/value>/g;
    let m;
    while ((m = valueRe.exec(content)) !== null) {
      items.push(parseXmlRpcValue(m[1]));
    }
    return items;
  }
  
  // Struct
  const structM = node.match(/<struct>([\s\S]*?)<\/struct>/);
  if (structM) {
    const obj = {};
    const memberRe = /<member>\s*<name>([\s\S]*?)<\/name>\s*<value>([\s\S]*?)<\/value>\s*<\/member>/g;
    let m;
    while ((m = memberRe.exec(structM[1])) !== null) {
      obj[m[1]] = parseXmlRpcValue(m[2]);
    }
    return obj;
  }
  
  // Plain value (no tag)
  const stripped = node.replace(/<[^>]+>/g, "").trim();
  if (stripped) return stripped;
  return null;
}

function parseXmlRpcResponse(xml) {
  if (xml.includes("<fault>")) {
    const valueM = xml.match(/<fault>\s*<value>([\s\S]*?)<\/value>\s*<\/fault>/);
    const fault = valueM ? parseXmlRpcValue(valueM[1]) : { faultString: "Unknown fault" };
    throw new Error("XML-RPC Fault: " + (fault.faultString || JSON.stringify(fault)));
  }
  const paramM = xml.match(/<params>\s*<param>\s*<value>([\s\S]*?)<\/value>\s*<\/param>\s*<\/params>/);
  if (!paramM) throw new Error("Réponse XML-RPC invalide: " + xml.slice(0, 200));
  return parseXmlRpcValue(paramM[1]);
}

async function xmlrpc(baseUrl, path, method, params) {
  const body = buildXmlRpc(method, params);
  const xml = await post(baseUrl + path, body, "text/xml");
  return parseXmlRpcResponse(xml);
}

// ─── Odoo via XML-RPC ────────────────────────────────────────────────────────

function getCfg() {
  const url = process.env.ODOO_URL;
  const db = process.env.ODOO_DATABASE;
  const login = process.env.ODOO_USERNAME;
  const apiKey = process.env.ODOO_API_KEY || process.env.ODOO_PASSWORD;
  if (!url || !db || !login || !apiKey) {
    throw new Error("Variables manquantes: ODOO_URL, ODOO_DATABASE, ODOO_USERNAME, ODOO_API_KEY");
  }
  return { url: url.replace(/\/$/, ""), db, login, apiKey };
}

async function getUid(cfg) {
  const uid = await xmlrpc(cfg.url, "/xmlrpc/2/common", "authenticate", [
    cfg.db, cfg.login, cfg.apiKey, {}
  ]);
  if (!uid || uid === false) throw new Error("Auth Odoo échouée - vérifiez login et clé API");
  return uid;
}

async function execute(cfg, uid, model, method, args, kwargs) {
  return xmlrpc(cfg.url, "/xmlrpc/2/object", "execute_kw", [
    cfg.db, uid, cfg.apiKey,
    model, method,
    args || [],
    kwargs || {}
  ]);
}

// ─── Outils MCP ──────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "odoo_search_read",
    description: "Recherche et lit des enregistrements dans n'importe quel modèle Odoo (res.partner, account.move, sale.order, project.task, etc.)",
    inputSchema: { type: "object", properties: {
      model: { type: "string" }, domain: { type: "array", items: { type: "array" }, default: [] },
      fields: { type: "array", items: { type: "string" }, default: [] },
      limit: { type: "number", default: 20 }, offset: { type: "number", default: 0 },
      order: { type: "string", default: "id desc" }
    }, required: ["model"] }
  },
  {
    name: "odoo_read_record",
    description: "Lit un ou plusieurs enregistrements Odoo par leurs IDs",
    inputSchema: { type: "object", properties: {
      model: { type: "string" }, ids: { type: "array", items: { type: "number" } },
      fields: { type: "array", items: { type: "string" }, default: [] }
    }, required: ["model", "ids"] }
  },
  {
    name: "odoo_get_fields",
    description: "Retourne la définition des champs d'un modèle Odoo",
    inputSchema: { type: "object", properties: {
      model: { type: "string" }, filter_type: { type: "string" }
    }, required: ["model"] }
  },
  {
    name: "odoo_list_models",
    description: "Liste tous les modèles disponibles dans l'instance Odoo",
    inputSchema: { type: "object", properties: { search: { type: "string" } } }
  },
  {
    name: "odoo_create_record",
    description: "Crée un nouvel enregistrement dans un modèle Odoo (contact, facture, tâche, etc.)",
    inputSchema: { type: "object", properties: {
      model: { type: "string" }, values: { type: "object" }
    }, required: ["model", "values"] }
  },
  {
    name: "odoo_update_record",
    description: "Met à jour des enregistrements existants dans Odoo",
    inputSchema: { type: "object", properties: {
      model: { type: "string" }, ids: { type: "array", items: { type: "number" } }, values: { type: "object" }
    }, required: ["model", "ids", "values"] }
  },
  {
    name: "odoo_delete_record",
    description: "Supprime des enregistrements Odoo par leurs IDs (ATTENTION: irréversible)",
    inputSchema: { type: "object", properties: {
      model: { type: "string" }, ids: { type: "array", items: { type: "number" } }
    }, required: ["model", "ids"] }
  },
  {
    name: "odoo_execute_method",
    description: "Exécute une méthode Odoo (ex: action_confirm, action_post, action_cancel)",
    inputSchema: { type: "object", properties: {
      model: { type: "string" }, ids: { type: "array", items: { type: "number" }, default: [] },
      method: { type: "string" }, kwargs: { type: "object", default: {} }
    }, required: ["model", "method"] }
  }
];

async function executeTool(name, args) {
  const cfg = getCfg();
  const uid = await getUid(cfg);

  switch (name) {
    case "odoo_search_read": {
      const { model, domain=[], fields=[], limit=20, offset=0, order="id desc" } = args;
      const records = await execute(cfg, uid, model, "search_read", [domain], { fields, limit, offset, order });
      const total = await execute(cfg, uid, model, "search_count", [domain]);
      return { model, total, count: (records||[]).length, records: records||[] };
    }
    case "odoo_read_record": {
      const { model, ids, fields=[] } = args;
      const records = await execute(cfg, uid, model, "read", [ids], { fields });
      return { model, records: records||[] };
    }
    case "odoo_get_fields": {
      const { model, filter_type } = args;
      let fields = await execute(cfg, uid, model, "fields_get", [], { attributes: ["string","type","required"] });
      if (filter_type && fields) fields = Object.fromEntries(Object.entries(fields).filter(([,v]) => v.type === filter_type));
      const count = fields ? Object.keys(fields).length : 0;
      return { model, field_count: count, fields: fields ? Object.fromEntries(Object.entries(fields).slice(0, 80)) : {} };
    }
    case "odoo_list_models": {
      const { search } = args;
      const domain = search ? [["model","like",search]] : [];
      const models = await execute(cfg, uid, "ir.model", "search_read", [domain], { fields: ["name","model"], limit: 100, order: "model asc" });
      return { count: (models||[]).length, models: models||[] };
    }
    case "odoo_create_record": {
      const newId = await execute(cfg, uid, args.model, "create", [args.values]);
      return { success: true, model: args.model, new_id: newId };
    }
    case "odoo_update_record": {
      const ok = await execute(cfg, uid, args.model, "write", [args.ids, args.values]);
      return { success: ok, model: args.model, updated_ids: args.ids };
    }
    case "odoo_delete_record": {
      const ok = await execute(cfg, uid, args.model, "unlink", [args.ids]);
      return { success: ok, model: args.model, deleted_ids: args.ids };
    }
    case "odoo_execute_method": {
      const { model, ids=[], method, kwargs={} } = args;
      const result = await execute(cfg, uid, model, method, ids.length > 0 ? [ids] : [], kwargs);
      return { success: true, model, method, result };
    }
    default: throw new Error("Outil inconnu: " + name);
  }
}

// ─── Handler Netlify ─────────────────────────────────────────────────────────

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
