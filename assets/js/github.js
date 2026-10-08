// Acceso al repositorio de GitHub que hace de "base de datos".
// Todo lo que se guarda aquí ya va cifrado; GitHub sólo ve bloques opacos.
import { utf8, b64 } from "./util.js";

const API = "https://api.github.com";
const FIRMA_COMMIT = { name: "umbral", email: "foro@umbral.invalid" };
export const CARPETAS = { posts: "foro/posts", usuarios: "foro/usuarios", correo: "correo" };

export class Repo {
  constructor({ owner, repo, branch }, token) {
    Object.assign(this, { owner, repo, branch, token });
    this.cache = new Map(); // oid -> texto (los blobs son inmutables)
  }

  async peticion(metodo, ruta, cuerpo) {
    const opciones = {
      method: metodo,
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: {
        Authorization: "Bearer " + this.token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(cuerpo ? { "Content-Type": "application/json" } : {}),
      },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    };
    // Los circuitos de Tor se cortan a veces: reintenta los fallos de red.
    let r;
    for (let intento = 0; ; intento++) {
      try { r = await fetch(API + ruta, opciones); break; } catch (e) {
        if (intento >= 3) throw new Error("No hay conexión con GitHub. Inténtalo de nuevo.");
        await new Promise((ok) => setTimeout(ok, 1000 * (intento + 1)));
      }
    }
    const datos = r.status === 204 ? null : await r.json().catch(() => null);
    if (!r.ok) {
      const e = new Error((datos && datos.message) || "GitHub respondió " + r.status);
      e.status = r.status;
      throw e;
    }
    return datos;
  }

  async graphql(query, variables = {}) {
    const d = await this.peticion("POST", "/graphql", { query, variables });
    if (d.errors) throw new Error(d.errors.map((e) => e.message).join("; "));
    return d.data;
  }

  // Devuelve { posts: [{nombre, oid, texto}], usuarios: [...], correo: [...] }.
  // Primero pide sólo nombres e ids y luego descarga únicamente los blobs nuevos.
  async listar() {
    const campos = Object.entries(CARPETAS).map(([alias, ruta]) =>
      `${alias}: object(expression: ${JSON.stringify(this.branch + ":" + ruta)}) { ... on Tree { entries { name oid type } } }`
    ).join("\n");
    const d = await this.graphql(
      `query($o: String!, $r: String!) { repository(owner: $o, name: $r) { ${campos} } }`,
      { o: this.owner, r: this.repo });
    const repo = d.repository;
    if (!repo) throw new Error("No se encuentra el repositorio");

    const res = {};
    const pendientes = new Set();
    for (const alias of Object.keys(CARPETAS)) {
      res[alias] = ((repo[alias] && repo[alias].entries) || [])
        .filter((e) => e.type === "blob" && e.name.endsWith(".json"))
        .map((e) => ({ nombre: e.name, oid: e.oid }));
      res[alias].forEach((e) => { if (!this.cache.has(e.oid)) pendientes.add(e.oid); });
    }

    const lista = [...pendientes];
    for (let i = 0; i < lista.length; i += 100) {
      const trozo = lista.slice(i, i + 100);
      const q = trozo.map((oid, j) => `b${j}: object(oid: "${oid}") { ... on Blob { text } }`).join("\n");
      const r = await this.graphql(
        `query($o: String!, $r: String!) { repository(owner: $o, name: $r) { ${q} } }`,
        { o: this.owner, r: this.repo });
      trozo.forEach((oid, j) => {
        const blob = r.repository["b" + j];
        if (blob && typeof blob.text === "string") this.cache.set(oid, blob.text);
      });
    }

    for (const alias of Object.keys(res)) {
      res[alias] = res[alias]
        .map((e) => ({ ...e, texto: this.cache.get(e.oid) }))
        .filter((e) => e.texto !== undefined);
    }
    return res;
  }

  // Si dos personas escriben a la vez GitHub puede devolver un conflicto (409);
  // se reintenta con una pequeña espera aleatoria.
  async conReintentos(metodo, ruta, cuerpo) {
    const url = `/repos/${this.owner}/${this.repo}/contents/${ruta}`;
    const datos = { ...cuerpo, branch: this.branch, committer: FIRMA_COMMIT, author: FIRMA_COMMIT };
    for (let intento = 0; ; intento++) {
      try {
        return await this.peticion(metodo, url, datos);
      } catch (e) {
        if (e.status !== 409 || intento >= 4) throw e;
        await new Promise((ok) => setTimeout(ok, 400 + Math.random() * 1200 * (intento + 1)));
      }
    }
  }

  crear(ruta, obj, mensaje = "actualización") {
    return this.conReintentos("PUT", ruta, { message: mensaje, content: b64(utf8(JSON.stringify(obj))) });
  }

  borrar(ruta, sha, mensaje = "entregado") {
    return this.conReintentos("DELETE", ruta, { message: mensaje, sha });
  }
}
