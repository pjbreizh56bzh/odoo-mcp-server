const axios = require("axios");

class OdooClient {
  constructor(config) {
    this.config = config;
    this.uid = null;
    this.http = axios.create({
      baseURL: config.url.replace(/\/$/, ""),
      timeout: 30000,
      headers: { "Content-Type": "application/json" }
    });
  }

  async rpc(endpoint, params) {
    const payload = {
      jsonrpc: "2.0",
      method: "call",
      id: Math.floor(Math.random() * 1000000),
      params
    };
    const response = await this.http.post(endpoint, payload);
    const data = response.data;
    if (data.error) {
      const errMsg = (data.error.data && data.error.data.message) || data.error.message || "Erreur Odoo";
      throw new Error(`Odoo RPC Error: ${errMsg}`);
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
    if (!result || !result.uid) {
      throw new Error("Authentification Odoo échouée. Vérifiez vos credentials.");
    }
    this.uid = result.uid;
    return this.uid;
  }

  async callKw(model, method, args = [], kwargs = {}) {
    await this.authenticate();
    return this.rpc("/web/dataset/call_kw", {
      model, method, args,
      kwargs: { ...kwargs, context: {} }
    });
  }

  async searchRead({ model, domain = [], fields = [], limit = 20, offset = 0, order = "id desc" }) {
    return (await this.callKw(model, "search_read", [], { domain, fields, limit, offset, order })) || [];
  }

  async searchCount(model, domain = []) {
    return await this.callKw(model, "search_count", [domain]);
  }

  async read(model, ids, fields = []) {
    return (await this.callKw(model, "read", [ids], { fields })) || [];
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

  async executeMethod(model, method, args = [], kwargs = {}) {
    return await this.callKw(model, method, args, kwargs);
  }
}

function getOdooClient() {
  const url = process.env.ODOO_URL;
  const database = process.env.ODOO_DATABASE;
  const username = process.env.ODOO_USERNAME;
  const apiKey = process.env.ODOO_API_KEY;
  const password = process.env.ODOO_PASSWORD;
  if (!url || !database || !username) {
    throw new Error("Configuration Odoo manquante: ODOO_URL, ODOO_DATABASE, ODOO_USERNAME requis");
  }
  return new OdooClient({ url, database, username, apiKey, password });
}

module.exports = { OdooClient, getOdooClient };
