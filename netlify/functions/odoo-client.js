const https = require("https");
const http = require("http");
const { URL } = require("url");

function httpRequest(urlStr, postData) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      },
      timeout: 25000
    };
    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("Invalid JSON: " + data.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(postData);
    req.end();
  });
}

class OdooClient {
  constructor(config) {
    this.config = config;
    this.uid = null;
    this.baseUrl = config.url.replace(/\/$/, "");
  }

  async rpc(endpoint, params) {
    const payload = JSON.stringify({
      jsonrpc: "2.0", method: "call",
      id: Math.floor(Math.random() * 1000000), params
    });
    const data = await httpRequest(this.baseUrl + endpoint, payload);
    if (data.error) {
      const msg = (data.error.data && data.error.data.message) || data.error.message || "Erreur Odoo";
      throw new Error("Odoo RPC Error: " + msg);
    }
    return data.result;
  }

  async authenticate() {
    if (this.uid !== null) return this.uid;
    const result = await this.rpc("/web/session/authenticate", {
      db: this.config.database,
      login: this.config.username,
      password: this.config.apiKey || this.config.password
    });
    if (!result || !result.uid) throw new Error("Auth Odoo échouée");
    this.uid = result.uid;
    return this.uid;
  }

  async callKw(model, method, args, kwargs) {
    await this.authenticate();
    return this.rpc("/web/dataset/call_kw", {
      model, method,
      args: args || [],
      kwargs: Object.assign({}, kwargs || {}, { context: {} })
    });
  }

  async searchRead(p) {
    return (await this.callKw(p.model, "search_read", [], {
      domain: p.domain || [], fields: p.fields || [],
      limit: p.limit || 20, offset: p.offset || 0, order: p.order || "id desc"
    })) || [];
  }

  async searchCount(model, domain) {
    return await this.callKw(model, "search_count", [domain || []]);
  }

  async read(model, ids, fields) {
    return (await this.callKw(model, "read", [ids], { fields: fields || [] })) || [];
  }

  async create(model, values) {
    return await this.callKw(model, "create", [values]);
  }

  async write(model, ids, values) {
    return await this.callKw(model, "write", [ids, values]);
  }

  async unlink(model, ids) {
    return await this.callKw(model, "unlink", [ids]);
  }

  async getFields(model, attributes) {
    return await this.callKw(model, "fields_get", [], {
      attributes: attributes || ["string", "type", "required", "readonly", "help"]
    });
  }

  async executeMethod(model, method, args, kwargs) {
    return await this.callKw(model, method, args || [], kwargs || {});
  }
}

function getOdooClient() {
  const url = process.env.ODOO_URL;
  const database = process.env.ODOO_DATABASE;
  const username = process.env.ODOO_USERNAME;
  const apiKey = process.env.ODOO_API_KEY;
  const password = process.env.ODOO_PASSWORD;
  if (!url || !database || !username) {
    throw new Error("Config manquante: ODOO_URL, ODOO_DATABASE, ODOO_USERNAME requis");
  }
  return new OdooClient({ url, database, username, apiKey, password });
}

module.exports = { OdooClient, getOdooClient };
