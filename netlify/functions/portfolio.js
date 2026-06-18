exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
      },
      body: ""
    };
  }

  const TOKEN = process.env.IBKR_FLEX_TOKEN;
  const QUERY_ID = process.env.IBKR_QUERY_ID || "1541787";

  if (!TOKEN) {
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "IBKR_FLEX_TOKEN no configurado en Netlify Environment Variables" })
    };
  }

  try {
    const reqUrl = `https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService.SendRequest?t=${TOKEN}&q=${QUERY_ID}&v=3`;
    const reqRes = await fetch(reqUrl);
    const reqText = await reqRes.text();

    const refMatch = reqText.match(/<ReferenceCode>(.*?)<\/ReferenceCode>/);
    const errMatch = reqText.match(/<ErrorMessage>(.*?)<\/ErrorMessage>/);

    if (!refMatch) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: errMatch ? errMatch[1] : "Sin código de referencia", step: 1, raw: reqText.slice(0, 1500) })
      };
    }
    const refCode = refMatch[1];

    let xmlData = null;
    let lastRaw = "";
    let attempts = 0;
    const MAX_ATTEMPTS = 10;
    while (attempts < MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, 3000));
      const getUrl = `https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService.GetStatement?q=${refCode}&t=${TOKEN}&v=3`;
      const getRes = await fetch(getUrl);
      const text = await getRes.text();
      lastRaw = text;

      if (text.includes("<ErrorMessage>")) {
        const em = text.match(/<ErrorMessage>(.*?)<\/ErrorMessage>/);
        // Retry on transient errors (1001 "could not be generated", "not yet available", etc.)
        if (em && /not yet available|generation in progress|try again|could not be generated/i.test(em[1])) {
          attempts++;
          continue;
        }
        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          body: JSON.stringify({ error: em ? em[1] : "Error desconocido", step: 2, raw: text.slice(0, 1500) })
        };
      }
      xmlData = text;
      break;
    }

    if (!xmlData) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: `IBKR no generó el informe tras ${MAX_ATTEMPTS} intentos (~${MAX_ATTEMPTS*3}s). Esto es un fallo temporal de los servidores de IBKR, no de la app. Pulsa Actualizar de nuevo en unos minutos.`, step: 3, raw: lastRaw.slice(0, 800) })
      };
    }

    // Parse OpenPosition elements (confirmed field names from real IBKR export)
    const positions = [];
    const posRegex = /<OpenPosition\b([^>]*?)\/?>/g;
    let match;
    while ((match = posRegex.exec(xmlData)) !== null) {
      const attrs = {};
      const attrRegex = /(\w+)="([^"]*)"/g;
      let attr;
      while ((attr = attrRegex.exec(match[1])) !== null) {
        let val = attr[2]
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'");
        attrs[attr[1]] = val;
      }
      if (attrs.symbol) positions.push(attrs);
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store"
      },
      body: JSON.stringify({
        positions,
        count: positions.length,
        fetchedAt: new Date().toISOString(),
        debug: positions.length === 0 ? xmlData.slice(0, 2000) : undefined
      })
    };

  } catch (err) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: err.message, step: "exception" })
    };
  }
};
