const { getOdooClient } = require("./odoo-client");

// ─── MCP Tool Definitions ────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "odoo_search_read",
    description: "Recherche et lit des enregistrements dans n'importe quel modèle Odoo (res.partner, account.move, sale.order, project.task, etc.)",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Modèle Odoo (ex: res.partner, account.move)" },
        domain: { type: "array", items: { type: "array" }, description: "Filtre domain Odoo", default: [] },
        fields: { type: "array", items: { type: "string" }, description: "Champs à retourner", default: [] },
        limit: { type: "number", description: "Nombre max de résultats (défaut: 20)", default: 20 },
        offset: { type: "number", description: "Pagination", default: 0 },
        order: { type: "string", description: "Tri (ex: name asc)", default: "id desc" }
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
        model: { type: "string", description: "Modèle Odoo" },
        ids: { type: "array", items: { type: "number" }, description: "IDs des enregistrements" },
        fields: { type: "array", items: { type: "string" }, description: "Champs à retourner", default: [] }
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
        model: { type: "string", description: "Modèle Odoo" },
        filter_type: { type: "string", description: "Filtrer par type: char, many2one, date, etc." }
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
        search: { type: "string", description: "Terme de recherche dans le nom du modèle" }
      }
    }
  },
  {
    name: "odoo_create_record",
    description: "Crée un nouvel enregistrement dans un modèle Odoo (contact, facture, tâche, etc.)",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Modèle Odoo cible" },
        values: { type: "object", description: "Valeurs du nouvel enregistrement" }
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
        model: { type: "string", description: "Modèle Odoo" },
        ids: { type: "array", items: { type: "number" }, description: "IDs à modifier" },
        values: { type: "object", description: "Champs et nouvelles valeurs" }
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
        model: { type: "string", description: "Modèle Odoo" },
        ids: { type: "array", items: { type: "number" }, description: "IDs à supprimer" }
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
        model: { type: "string", description: "Modèle Odoo" },
        ids: { type: "array", items: { type: "number" }, description: "IDs des enregistrements", default: [] },
        method: { type: "string", description: "Méthode à appeler" },
        kwargs: { type: "object", description: "Arguments additionnels", default: {} }
      },
      required: ["model", "method"]
    }
  }
];

// ─── Tool Execution ──────────────────────────────────────────────────────────

async function executeTool(name, args) {
  const client = getOdooClient();

  switch (name) {
    case "odoo_search_read": {
      const { model, domain = [], fields = [], limit = 20, offset = 0, order = "id desc" } = args;
      const records = await client.searchRead({ model, domain, fields, limit, offset, order });
      const total = await client.searchCount(model, domain);
      return { model, total, count: records.length, offset, has_more: total > offset + records.length, records };
    }

    case "odoo_read_record": {
      const { model, ids, fields = [] } = args;
      const records = await client.read(model, ids, fields);
      return { model, records };
    }

    case "odoo_get_fields": {
      const { model, filter_type } = args;
      let fields = await client.getFields(model);
      if (filter_type) {
        fields = Object.fromEntries(Object.entries(fields).filter(([, v]) => v.type === filter_type));
      }
      const fieldCount = Object.keys(fields).length;
      const summary = Object.fromEntries(
        Object.entries(fields).slice(0, 100).map(([k, v]) => [k, { type: v.type, string: v.string, required: v.required }])
      );
      return { model, field_count: fieldCount, fields: summary };
    }

    case "odoo_list_models": {
      const { search } = args;
      const domain = search ? [["model", "like", search]] : [];
      const models = await client.searchRead({ model: "ir.model", domain, fields: ["name", "model"], limit: 100, order: "model asc" });
      return { count: models.length, models };
    }

    case "odoo_create_record": {
      const { model, values } = args;
      const newId = await client.create(model, values);
      return { success: true, model, new_id: newId, message: `Enregistrement créé avec l'ID ${newId}` };
    }

    case "odoo_update_record": {
      const { model, ids, values } = args;
      const success = await client.write(model, ids, values);
      return { success, model, updated_ids: ids, updated_count: ids.length, message: `${ids.length} enregistrement(s) mis à jour` };
    }

    case "odoo_delete_record": {
      const { model, ids } = args;
      const success = await client.unlink(model, ids);
      return { success, model, deleted_ids: ids, message: `${ids.length} enregistrement(s) supprimé(s)` };
    }

    case "odoo_execute_method": {
      const { model, ids = [], method, kwargs = {} } = args;
      const callArgs = ids && ids.length > 0 ? [ids] : [];
      const result = await client.executeMethod(model, method, callArgs, kwargs);
      return { success: true, model, method, ids, result };
    }

    default:
      throw new Error(`Outil inconnu: ${name}`);
  }
}

// ─── MCP Protocol Handler ────────────────────────────────────────────────────

exports.handler = async function(event, context) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };

  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  // Handle GET - server info
  if (event.httpMethod === "GET") {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        name: "odoo-mcp-server",
        version: "1.0.0",
        description: "MCP Server for Odoo - BZHandiBreizh",
        tools: TOOLS.map(t => t.name)
      })
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { jsonrpc, id, method, params } = body;

  // MCP protocol methods
  try {
    let result;

    if (method === "initialize") {
      result = {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "odoo-mcp-server", version: "1.0.0" }
      };
    } else if (method === "notifications/initialized") {
      return { statusCode: 200, headers, body: JSON.stringify({ jsonrpc: "2.0", id, result: {} }) };
    } else if (method === "tools/list") {
      result = { tools: TOOLS };
    } else if (method === "tools/call") {
      const { name, arguments: args } = params;
      const toolResult = await executeTool(name, args || {});
      result = {
        content: [{ type: "text", text: JSON.stringify(toolResult, null, 2) }]
      };
    } else if (method === "ping") {
      result = {};
    } else {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Méthode inconnue: ${method}` }
        })
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, result })
    };

  } catch (error) {
    console.error("MCP Error:", error.message);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: error.message }
      })
    };
  }
};
