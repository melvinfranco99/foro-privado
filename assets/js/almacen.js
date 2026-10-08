// Almacenamiento local (IndexedDB) de los mensajes privados.
// Cada mensaje se guarda cifrado con una clave que sólo se obtiene con la contraseña
// del usuario, así que aunque alguien copie el perfil del navegador no puede leerlos.
import { cifrar, descifrar } from "./cripto.js";

const DB = "umbral";
const TABLA = "mensajes";

function abrirDb() {
  return new Promise((ok, no) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(TABLA, { keyPath: "k" }).createIndex("u", "u");
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
}

async function tx(modo, fn) {
  const db = await abrirDb();
  return new Promise((ok, no) => {
    const t = db.transaction(TABLA, modo);
    const res = fn(t.objectStore(TABLA));
    t.oncomplete = () => { db.close(); ok(res && "result" in res ? res.result : undefined); };
    t.onerror = () => { db.close(); no(t.error); };
  });
}

export async function guardar(yo, msg) {
  const fila = { k: yo.id + "|" + msg.id, u: yo.id, sobre: await cifrar(yo.claveLocal, msg) };
  await tx("readwrite", (s) => s.put(fila));
}

async function filas(yo) {
  return tx("readonly", (s) => s.index("u").getAll(yo.id));
}

export async function cargar(yo) {
  const out = [];
  for (const f of await filas(yo)) {
    try { out.push(await descifrar(yo.claveLocal, f.sobre)); } catch { /* otra contraseña */ }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export async function borrarConversacion(yo, otroId) {
  const msgs = await cargar(yo);
  await tx("readwrite", (s) => {
    msgs.filter((m) => m.con === otroId).forEach((m) => s.delete(yo.id + "|" + m.id));
  });
}

// Copia de seguridad: sigue cifrada, sólo se puede importar con la misma cuenta.
export async function exportar(yo) {
  return JSON.stringify({ umbral: 1, usuario: yo.id, filas: await filas(yo) });
}

export async function importar(yo, texto) {
  const d = JSON.parse(texto);
  if (d.umbral !== 1 || d.usuario !== yo.id) throw new Error("La copia no es de esta cuenta.");
  let n = 0;
  for (const f of d.filas) {
    try {
      const msg = await descifrar(yo.claveLocal, f.sobre);
      await guardar(yo, msg);
      n++;
    } catch { /* fila corrupta */ }
  }
  return n;
}

export async function pedirPersistencia() {
  try { return await navigator.storage.persist(); } catch { return false; }
}
