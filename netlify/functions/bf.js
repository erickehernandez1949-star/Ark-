const https = require("https");

exports.handler = async function (event) {
  const shipment = event.queryStringParameters?.shipment;
  if (!shipment) {
    return { statusCode: 400, body: JSON.stringify({ error: "Falta shipment" }) };
  }

  const pasosOrden = [
    { key: "creado",      title: "Creado" },
    { key: "registrado",  title: "Registrado" },
    { key: "recolect",    title: "Recolectado" },
    { key: "ruta",        title: "Ruta a destino" },
    { key: "entreg",      title: "Entregado" }
  ];

  try {
    const url = `https://tracking.goboxful.com/?shipment=${shipment}`;
    const html = await fetchHtml(url);

    // ESTRATEGIA PRINCIPAL: Box Full usa Next.js y embebe los datos en
    // self.__next_f.push([1,"...shipmentInfo..."])
    // El JSON completo del shipment está ahí con statusHistory
    
    let shipmentData = null;

    // Buscar el bloque que contiene shipmentInfo y statusHistory
    const nextFMatches = html.match(/self\.__next_f\.push\(\[1,"(.+?)"\]\)/g) || [];
    
    for (const block of nextFMatches) {
      if (block.includes('shipmentInfo') && block.includes('statusHistory')) {
        // Extraer el string interno y decodificarlo
        try {
          // El contenido está JSON-encoded dentro del push
          const innerMatch = block.match(/self\.__next_f\.push\(\[1,"([\s\S]+?)"\]\)/);
          if (innerMatch) {
            // Decodificar los escapes de JSON
            const decoded = innerMatch[1]
              .replace(/\\"/g, '"')
              .replace(/\\\\/g, '\\')
              .replace(/\\n/g, '\n');
            
            // Buscar el objeto shipmentInfo dentro
            const siMatch = decoded.match(/"shipmentInfo"\s*:\s*(\{[\s\S]+?"statusHistory"\s*:\s*\[[\s\S]+?\]\s*[^}]*\})/);
            if (siMatch) {
              // Extraer solo la parte del shipment con statusHistory
              const shMatch = decoded.match(/"statusHistory"\s*:\s*(\[[\s\S]+?\])\s*,\s*"allowCustomization"/);
              if (shMatch) {
                const statusHistory = JSON.parse(shMatch[1]);
                shipmentData = { statusHistory };
                
                // También extraer courier y fechas
                const courierMatch = decoded.match(/"courier"\s*:\s*"([^"]+)"/);
                const estMatch = decoded.match(/"estimatedDeliveryDate"\s*:\s*"([^"]+)"/);
                if (courierMatch) shipmentData.courier = courierMatch[1];
                if (estMatch) shipmentData.estimatedDelivery = estMatch[1];
                break;
              }
            }
          }
        } catch(e) { continue; }
      }
    }

    // Si no funcionó el método anterior, intentar buscar directamente el statusHistory
    if (!shipmentData) {
      const shDirect = html.match(/"statusHistory"\s*:\s*(\[[\s\S]*?\{[\s\S]*?"statusDescription"[\s\S]*?\}\s*\])/);
      if (shDirect) {
        try {
          const statusHistory = JSON.parse(shDirect[1]);
          shipmentData = { statusHistory };
        } catch(e) {}
      }
    }

    if (shipmentData && shipmentData.statusHistory && shipmentData.statusHistory.length > 0) {
      const steps = pasosOrden.map(paso => {
        const event = shipmentData.statusHistory.find(e => {
          const desc = (e.statusDescription || '').toLowerCase();
          return desc.includes(paso.key);
        });
        if (event) {
          const fecha = formatDate(event.date);
          return { title: paso.title, date: fecha, done: true };
        }
        return { title: paso.title, date: 'Pendiente', done: false };
      });

      // Propagar: si un paso posterior está done, los anteriores también
      let last = -1;
      steps.forEach((s, i) => { if (s.done) last = i; });
      steps.forEach((s, i) => { if (i <= last && !s.done) { s.done = true; s.date = 'Completado'; } });

      // Fecha estimada
      let fechaEstimada = null;
      if (shipmentData.estimatedDelivery) {
        fechaEstimada = formatDate(shipmentData.estimatedDelivery);
      }

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({
          steps,
          paqueteria: shipmentData.courier || 'Forza Delivery Express',
          fechaEstimada
        })
      };
    }

    // FALLBACK: buscar pasos en texto del HTML
    const steps = pasosOrden.map(paso => {
      const r = new RegExp(`${paso.title}[\\s\\S]{0,200}?(\\d{1,2}\\s+\\w+\\s+\\d{4}[^"]{0,20}\\d{1,2}:\\d{2})`, 'i');
      const m = html.match(r);
      if (m) return { title: paso.title, date: m[1].trim(), done: true };
      if (html.includes(paso.title)) return { title: paso.title, date: 'Completado', done: true };
      return { title: paso.title, date: 'Pendiente', done: false };
    });
    let last = -1;
    steps.forEach((s, i) => { if (s.done) last = i; });
    steps.forEach((s, i) => { if (i <= last && !s.done) { s.done = true; s.date = 'Completado'; } });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ steps, paqueteria: 'Forza Delivery Express' })
    };

  } catch (error) {
    const steps = pasosOrden.map(p => ({ title: p.title, date: 'Pendiente', done: false }));
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ steps, sinConexion: true, errorMsg: error.message })
    };
  }
};

function formatDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString('es-HN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
      timeZone: 'America/Tegucigalpa'
    });
  } catch(e) { return iso; }
}

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-HN,es;q=0.9",
        "Cache-Control": "no-cache"
      },
      timeout: 12000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchHtml(res.headers.location).then(resolve).catch(reject);
        return;
      }
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
  });
}
