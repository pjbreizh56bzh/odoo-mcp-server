const https = require("https");
const http = require("http");
const { URL } = require("url");

// ─── HTTP Client natif ───────────────────────────────────────────────────────

function rpcCall(baseUrl, endpoint, params) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      jsonrpc: "2.0", method: "call",
      id: Math.floor(Math.random() * 1000000), params
    });

    const url = new URL(baseUrl.replace(/\/$/, "") + endpoint);
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      }
    };

    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            const msg = (json.error.data && json.error.data.message) || json.error.message || "Erreur Odoo";
            reject(new Error(msg));
          } else {
            resolve(json.result);
          }
        } catch(e) {
          reject(new Error("Réponse Odoo invalide: " + data.slice(0, 300)));
        }
      });
    });

    req.on("error", (e) => reject(new Error("Connexion échouée: " + e.message)));
    req.setTimeout(20000, () => { req.destroy(); reject(new Error("Timeout 20s")); });
    req.write(payload);
    req.end();
  });
}

// ─── Odoo Auth + callKw ──────────────────────────────────────────────────────

async function getUid(cfg) {
  const result = await rpcCall(cfg.url, "/web/session/authenticate", {
    db: cfg.db, login: cfg.login, password: cfg.apiKey
  });
  if (!result || !result.uid) throw new Error("Auth Odoo échouée - vérifiez login/apiKey");
  return result.uid;
}

async function callKw(cfg, uid, model, method, args, kwargs) {
  return rpcCall(cfg.url, "/web/dataset/call_kw", {
    model, method,
    args: args || [],
    kwargs: Object.assign({}, kwargs || {}, { context: {} })
  });
}

function getCfg() {
  const url = process.env.ODOO_URL;
  const db = process.env.ODOO_DATABASE;
  const login = process.env.ODOO_USERNAME;
  const apiKey = process.env.ODOO_API_KEY || process.env.ODOO_PASSWORD;
  if (!url || !db || !login || !apiKey) {
    throw new Error("Variables manquantes: ODOO_URL, ODOO_DATABASE, ODOO_USERNAME, ODOO_API_KEY");
  }
  return { url, db, login, apiKey };
}

// ─── Outils MCP ──────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "odoo_search_read",
    description: "Recherche et lit des enregistrements dans n'importe quel modèle Odoo (res.partner, account.move, sale.order, project.task, etc.)",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Modèle Odoo (ex: res.partner)" },
        domain: { type: "array", items: { type: "array" }, default: [] },
        fields: { type: "array", items: { type: "string" }, default: [] },
        limit: { type: "number", default: 20 },
        offset: { type: "number", default: 0 },
        order: { type: "string", default: "id desc" }
      },
      required: ["model"]
    }
  },
  {
    name: "odoo_read_record",
    description: "Lit un ou plusieurs enregistrements Odoo par leurs IDs",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        ids: { type: "array", items: { type: "number" } },
        fields: { type: "array", items: { type: "string" }, default: [] }
      },
      required: ["model", "ids"]
    }
  },
  {
    name: "odoo_get_fields",
    description: "Retourne la définition des champs d'un modèle Odoo",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        filter_type: { type: "string" }
      },
      required: ["model"]
    }
  },
  {
    name: "odoo_list_models",
    description: "Liste tous les modèles disponibles dans l'instance Odoo",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string" }
      }
    }
  },
  {
    name: "odoo_create_record",
    description: "Crée un nouvel enregistrement dans un modèle Odoo",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        values: { type: "object" }
      },
      required: ["model", "values"]
    }
  },
  {
    name: "odoo_update_record",
    description: "Met à jour des enregistrements existants dans Odoo",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        ids: { type: "array", items: { type: "number" } },
        values: { type: "object" }
      },
      required: ["model", "ids", "values"]
    }
  },
  {
    name: "odoo_delete_record",
    description: "Supprime des enregistrements Odoo par leurs IDs (ATTENTION: irréversible)",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        ids: { type: "array", items: { type: "number" } }
      },
      required: ["model", "ids"]
    }
  },
  {
    name: "odoo_execute_method",
    description: "Exécute une méthode Odoo (ex: action_confirm, action_post, action_cancel)",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        ids: { type: "array", items: { type: "number" }, default: [] },
        method: { type: "string" },
        kwargs: { type: "object", default: {} }
      },
      required: ["model", "method"]
    }
  }
];

// ─── Exécution des outils ────────────────────────────────────────────────────

async function executeTool(name, args) {
  const cfg = getCfg();
  const uid = await getUid(cfg);

  switch (name) {
    case "odoo_search_read": {
      const { model, domain=[], fields=[], limit=20, offset=0, order="id desc" } = args;
      const records = await callKw(cfg, uid, model, "search_read", [], { domain, fields, limit, offset, order });
      const total = await callKw(cfg, uid, model, "search_count", [domain]);
      return { model, total, count: (records||[]).length, offset, records: records||[] };
    }
    case "odoo_read_record": {
      const { model, ids, fields=[] } = args;
      const records = await callKw(cfg, uid, model, "read", [ids], { fields });
      return { model, records: records||[] };
    }
    case "odoo_get_fields": {
      const { model, filter_type } = args;
      let fields = await callKw(cfg, uid, model, "fields_get", [], {
        attributes: ["string", "type", "required"]
      });
      if (filter_type && fields) {
        fields = Object.fromEntries(Object.entries(fields).filter(([,v]) => v.type === filter_type));
      }
      const count = fields ? Object.keys(fields).length : 0;
      const summary = fields ? Object.fromEntries(Object.entries(fields).slice(0, 80)) : {};
      return { model, field_count: count, fields: summary };
    }
    case "odoo_list_models": {
      const { search } = args;
      const domain = search ? [["model", "like", search]] : [];
      const models = await callKw(cfg, uid, "ir.model", "search_read", [], {
        domain, fields: ["name", "model"], limit: 100, order: "model asc"
      });
      return { count: (models||[]).length, models: models||[] };
    }
    case "odoo_create_record": {
      const { model, values } = args;
      const newId = await callKw(cfg, uid, model, "create", [values]);
      return { success: true, model, new_id: newId };
    }
    case "odoo_update_record": {
      const { model, ids, values } = args;
      const success = await callKw(cfg, uid, model, "write", [ids, values]);
      return { success, model, updated_ids: ids, count: ids.length };
    }
    case "odoo_delete_record": {
      const { model, ids } = args;
      const success = await callKw(cfg, uid, model, "unlink", [ids]);
      return { success, model, deleted_ids: ids };
    }
    case "odoo_execute_method": {
      const { model, ids=[], method, kwargs={} } = args;
      const callArgs = ids.length > 0 ? [ids] : [];
      const result = await callKw(cfg, uid, model, method, callArgs, kwargs);
      return { success: true, model, method, result };
    }
    default:
      throw new Error("Outil inconnu: " + name);
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

  if (event.httpMethod === "GET") {
    return { statusCode: 200, headers, body: JSON.stringify({ name: "odoo-mcp-server", version: "1.0.0" }) };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { jsonrpc, id, method, params } = body;

  try {
    let result;

    if (method === "initialize") {
      result = {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "odoo-mcp-server", version: "1.0.0" }
      };
    } else if (method === "notifications/initialized" || method === "ping") {
      result = {};
    } else if (method === "tools/list") {
      result = { tools: TOOLS };
    } else if (method === "tools/call") {
      const toolName = params && params.name;
      const toolArgs = (params && params.arguments) || {};
      try {
        const toolResult = await executeTool(toolName, toolArgs);
        result = {
          content: [{ type: "text", text: JSON.stringify(toolResult, null, 2) }]
        };
      } catch (toolErr) {
        result = {
          content: [{ type: "text", text: "Erreur: " + toolErr.message }],
          isError: true
        };
      }
    } else {
      return { statusCode: 200, headers, body: JSON.stringify({
        jsonrpc: "2.0", id,
        error: { code: -32601, message: "Méthode inconnue: " + method }
      })};
    }

    return { statusCode: 200, headers, body: JSON.stringify({ jsonrpc: "2.0", id, result }) };

  } catch (err) {
    console.error("MCP Error:", err.message);
    return { statusCode: 200, headers, body: JSON.stringify({
      jsonrpc: "2.0", id,
      error: { code: -32000, message: err.message }
    })};
  }
};
