// Netlify function: fetches IBKR Flex Query report and returns parsed positions

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
    // Step 1: Request the report generation
    const reqUrl = `https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService.SendRequest?t=${TOKEN}&q=${QUERY_ID}&v=3`;
    const reqRes = await fetch(reqUrl);
    const reqText = await reqRes.text();

    const refMatch = reqText.match(/<ReferenceCode>(.*?)<\/ReferenceCode>/);
    const errMatch = reqText.match(/<ErrorMessage>(.*?)<\/ErrorMessage>/);

    if (!refMatch) {
      return {
        statusCode: 500,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({
          error: errMatch ? errMatch[1] : "No se pudo obtener el código de referencia",
          raw: reqText.slice(0, 1000)
        })
      };
    }
    const refCode = refMatch[1];

    // Step 2: Poll for the report (it can take a few seconds to generate)
    let xmlData = null;
    let attempts = 0;
    while (attempts < 6) {
      await new Promise(r => setTimeout(r, 2500));
      const getUrl = `https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService.GetStatement?q=${refCode}&t=${TOKEN}&v=3`;
      const getRes = await fetch(getUrl);
      const text = await getRes.text();

      // If still processing, IBKR returns an error message asking to wait
      if (text.includes("<ErrorMessage>") && text.includes("not yet available")) {
        attempts++;
        continue;
      }
      xmlData = text;
      break;
    }

    if (!xmlData) {
      return {
        statusCode: 500,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "El informe de IBKR no estuvo listo a tiempo. Inténtalo de nuevo en unos segundos." })
      };
    }

    // Check for error in final response
    const finalErr = xmlData.match(/<ErrorMessage>(.*?)<\/ErrorMessage>/);
    if (finalErr) {
      return {
        statusCode: 500,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: finalErr[1], raw: xmlData.slice(0, 1000) })
      };
    }

    // Step 3: Parse OpenPosition elements from XML
    const positions = [];
    const posRegex = /<OpenPosition\b([^>]*?)\/?>/g;
    let match;
    while ((match = posRegex.exec(xmlData)) !== null) {
      const attrs = {};
      const attrRegex = /(\w+)="([^"]*)"/g;
      let attr;
      while ((attr = attrRegex.exec(match[1])) !== null) {
        // Decode XML entities
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
      body: JSON.stringify({ positions, count: positions.length, fetchedAt: new Date().toISOString() })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: err.message })
    };
  }
};
