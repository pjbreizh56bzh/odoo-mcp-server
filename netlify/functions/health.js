exports.handler = async function(event, context) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      status: "ok",
      server: "odoo-mcp-server",
      version: "1.0.0",
      odoo_url: process.env.ODOO_URL || "non configuré",
      odoo_database: process.env.ODOO_DATABASE || "non configuré"
    })
  };
};
