// Comprobación de que el visitante usa Tor Browser.
//
// Una web estática en GitHub Pages no puede bloquear conexiones en el servidor,
// así que la comprobación se hace en el navegador, en dos pasos:
//   1. Sin red: Tor Browser siempre se presenta como Firefox con zona horaria UTC.
//      Si no lo parece, se bloquea sin hacer ninguna petición (no se filtra la IP real).
//   2. Con red: se pregunta la IP de salida y se comprueba en el directorio público
//      de Tor (Onionoo) que pertenece a un relé de Tor.

const tiempo = (ms, p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error("tiempo agotado")), ms))]);

function pareceTorBrowser() {
  const ua = navigator.userAgent || "";
  const zona = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  const utc = new Date().getTimezoneOffset() === 0 && /^(UTC|Etc\/UTC|Etc\/GMT|GMT|Atlantic\/Reykjavik)$/.test(zona);
  return /Firefox\/\d+/.test(ua) && !/Chrome|Edg|OPR/.test(ua) && utc;
}

async function esIpDeTor() {
  const pedir = (u) => tiempo(15000, fetch(u, { cache: "no-store", referrerPolicy: "no-referrer", credentials: "omit" })).then((r) => r.json());
  const { ip } = await pedir("https://api.ipify.org?format=json");
  const d = await pedir("https://onionoo.torproject.org/summary?search=" + encodeURIComponent(ip));
  const limpia = (a) => a.replace(/^\[|\]$/g, "");
  return (d.relays || []).some((r) => (r.a || []).some((a) => limpia(a) === ip));
}

// Devuelve { ok, motivo }.
export async function comprobarTor() {
  if (!pareceTorBrowser()) {
    return { ok: false, motivo: "Este navegador no es Tor Browser." };
  }
  try {
    if (await esIpDeTor()) return { ok: true };
    return { ok: false, motivo: "Tu conexión no sale por la red Tor. Si estás en Tor Browser, pide un circuito nuevo (Ctrl+Mayús+L) y recarga." };
  } catch {
    return { ok: false, motivo: "No se ha podido verificar la conexión Tor. Comprueba que el nivel de seguridad no sea «El más seguro» y recarga." };
  }
}
