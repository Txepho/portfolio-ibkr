exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
      },
      body: ""
    };
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "API key no configurada" })
    };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: "Bad request" };
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "mcp-client-2025-04-04"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      system: "You have IBKR MCP access. Use the requested tool. Return ONLY the raw JSON from the tool result. No markdown, no explanation, no wrapping.",
      messages: body.messages,
      mcp_servers: [{ type: "url", url: "https://api.ibkr.com/v1/api/mcp", name: "ibkr-mcp" }]
    })
  });

  const data = await response.json();

  // Try to extract MCP tool result directly
  let result = null;
  if (data.content) {
    for (const block of data.content) {
      if (block.type === "mcp_tool_result") {
        try {
          result = JSON.parse(block.content?.[0]?.text || "null");
        } catch { result = block.content?.[0]?.text; }
        break;
      }
    }
    // Fallback: try text blocks
    if (!result) {
      for (const block of data.content) {
        if (block.type === "text" && block.text) {
          try {
            const clean = block.text.replace(/`json|```/g, "").trim();
            result = JSON.parse(clean);
            break;
          } catch { continue; }
        }
      }
    }
  }

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    },
    body: JSON.stringify({ result, raw: data })
  };
};
