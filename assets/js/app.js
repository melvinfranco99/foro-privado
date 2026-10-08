import { comprobarTor } from "./tor.js";
import { Repo, CARPETAS } from "./github.js";
import * as C from "./cripto.js";
import * as Almacen from "./almacen.js";
import { b64, fileId } from "./util.js";

const NOMBRE_FORO = "Umbral";
const INTERVALO = 30000;
const LIMITES = { titulo: 120, cuerpo: 10000, mensaje: 5000 };

const raiz = document.getElementById("app");
const estado = {
  cfg: null, clave: null, repo: null, yo: null,
  usuarios: new Map(),   // id -> { nombre, signPk, boxPk, ts }
  posts: [],             // publicaciones verificadas
  mensajes: [],          // mensajes privados locales
  descifrados: new Map(),// oid -> objeto o null
  correoAjeno: new Set(),// oids de correo que no son para mí
  borradores: {},
  sincronizando: false, error: null,
};

// ---------- utilidades de interfaz ----------

function h(tag, attrs = {}, ...hijos) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of hijos.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const fecha = (ts) => new Date(ts).toLocaleString("es-ES", {
  day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC",
}) + " UTC";

function pantalla(...hijos) {
  raiz.replaceChildren(...hijos);
}

function aviso(texto, tipo = "error") {
  return h("p", { class: "aviso " + tipo, role: tipo === "error" ? "alert" : "status" }, texto);
}

function boton(texto, onclick, extra = {}) {
  return h("button", { type: "button", onclick, ...extra }, texto);
}

// Textarea que conserva el borrador aunque la vista se vuelva a pintar.
function areaTexto(clave, attrs) {
  const t = h("textarea", { ...attrs, oninput: () => { estado.borradores[clave] = t.value; } });
  t.value = estado.borradores[clave] || "";
  return t;
}

async function ocupado(btn, fn) {
  const texto = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Un momento…";
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = texto; }
}

// ---------- arranque ----------

async function iniciar() {
  pantalla(h("div", { class: "centro" }, h("div", { class: "logo" }, NOMBRE_FORO),
    h("p", { class: "tenue" }, "Comprobando que entras por la red Tor…")));

  const tor = await comprobarTor();
  if (!tor.ok) return pantallaBloqueo(tor.motivo);

  try {
    const r = await fetch("config.json", { cache: "no-store" });
    if (!r.ok) throw new Error();
    estado.cfg = await r.json();
  } catch {
    return pantalla(h("div", { class: "centro" }, h("div", { class: "logo" }, NOMBRE_FORO),
      aviso("El foro todavía no está configurado.", "info"),
      h("p", {}, h("a", { href: "setup.html" }, "Configurar el foro (administración)"))));
  }
  pantallaAcceso();
}

function pantallaBloqueo(motivo) {
  pantalla(h("div", { class: "centro" },
    h("div", { class: "logo" }, NOMBRE_FORO),
    h("h1", {}, "Acceso sólo a través de Tor"),
    aviso(motivo),
    h("p", {}, "Este foro sólo se abre desde ", h("strong", {}, "Tor Browser"),
      ". Descárgalo de la web oficial del Proyecto Tor (torproject.org), conéctate y vuelve a abrir esta dirección."),
    h("p", { class: "tenue" }, "No se ha enviado ninguna información sobre ti para hacer esta comprobación.")));
}

// ---------- acceso ----------

function pantallaAcceso(modo = "entrar", error = null) {
  const registro = modo === "registro";
  const campo = (etiqueta, attrs) => h("label", {}, etiqueta, h("input", { required: true, ...attrs }));
  const frase = campo("Frase de acceso del foro", { type: "password", autocomplete: "off", name: "frase" });
  const nombre = campo("Seudónimo", { type: "text", autocomplete: "off", name: "nombre", maxlength: 24, spellcheck: "false" });
  const pass = campo("Contraseña", { type: "password", autocomplete: "off", name: "pass", minlength: registro ? 10 : 1 });
  const pass2 = registro ? campo("Repite la contraseña", { type: "password", autocomplete: "off", name: "pass2" }) : null;
  const enviar = h("button", { type: "submit", class: "primario" }, registro ? "Crear cuenta" : "Entrar");

  const form = h("form", { class: "tarjeta acceso", onsubmit: async (ev) => {
    ev.preventDefault();
    const f = new FormData(form);
    await ocupado(enviar, () => acceder(registro, f).catch((e) => pantallaAcceso(modo, e.message)));
  } },
  h("div", { class: "pestanas" },
    boton("Entrar", () => pantallaAcceso("entrar"), { class: registro ? "" : "activa" }),
    boton("Crear cuenta", () => pantallaAcceso("registro"), { class: registro ? "activa" : "" })),
  error && aviso(error),
  frase, nombre, pass, pass2,
  registro && h("p", { class: "tenue" },
    "Usa un seudónimo inventado, nunca tu nombre real. La contraseña no se puede recuperar: ",
    "de ella salen tus claves de cifrado y nadie más la conoce."),
  enviar);

  pantalla(h("div", { class: "centro" }, h("div", { class: "logo" }, NOMBRE_FORO),
    h("p", { class: "tenue" }, "Foro privado · cifrado de extremo a extremo"), form));
  form.querySelector("input").focus();
}

async function acceder(registro, f) {
  const nombre = C.normalizarNombre(f.get("nombre"));
  if (!C.NOMBRE_VALIDO.test(nombre)) {
    throw new Error("El seudónimo debe tener de 3 a 24 caracteres: letras, números, «_», «-» o «.».");
  }
  if (registro && f.get("pass") !== f.get("pass2")) throw new Error("Las contraseñas no coinciden.");

  const cfg = estado.cfg;
  const clave = await C.claveForo(f.get("frase"), cfg.salt, cfg.iter);
  let token;
  try {
    if ((await C.descifrar(clave, cfg.check)) !== "umbral-ok") throw new Error();
    token = await C.descifrar(clave, cfg.token);
  } catch {
    throw new Error("La frase de acceso del foro no es correcta.");
  }
  estado.clave = clave;
  estado.repo = new Repo(cfg, token);
  await sincronizar(false);

  const yo = await C.identidad(nombre, f.get("pass"), cfg.salt, cfg.iter);
  const existente = estado.usuarios.get(yo.id);
  const signPk = b64(yo.signPk);

  if (registro) {
    if (existente) throw new Error("Ese seudónimo ya está ocupado.");
    const ficha = C.firmar({ nombre: yo.nombre, signPk, boxPk: b64(yo.boxPk), ts: Date.now() }, yo.signSk);
    await estado.repo.crear(`${CARPETAS.usuarios}/${yo.id}.json`, await C.cifrar(clave, ficha), "nuevo usuario");
    estado.usuarios.set(yo.id, ficha);
  } else {
    if (!existente) throw new Error("No existe ninguna cuenta con ese seudónimo.");
    if (existente.signPk !== signPk) throw new Error("Contraseña incorrecta.");
    yo.nombre = existente.nombre;
  }

  estado.yo = yo;
  Almacen.pedirPersistencia();
  await procesarCorreo();
  estado.mensajes = await Almacen.cargar(yo);
  setInterval(() => { if (!document.hidden) refrescar(); }, INTERVALO);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refrescar(); });
  window.addEventListener("hashchange", pintar);
  if (!location.hash) location.hash = "#/foro";
  pintar();
}

// ---------- sincronización ----------

async function descifrarFichero(e) {
  if (estado.descifrados.has(e.oid)) return estado.descifrados.get(e.oid);
  let obj = null;
  try { obj = await C.descifrar(estado.clave, JSON.parse(e.texto)); } catch { /* ignorado */ }
  estado.descifrados.set(e.oid, obj);
  return obj;
}

async function sincronizar(conCorreo = true) {
  const datos = await estado.repo.listar();
  estado.ultimoListado = datos;

  const usuarios = new Map();
  for (const e of datos.usuarios) {
    const u = await descifrarFichero(e);
    const id = e.nombre.replace(/\.json$/, "");
    if (u && C.verificar(u, u.signPk) && (await C.idUsuario(u.nombre, estado.cfg.salt)) === id) {
      usuarios.set(id, u);
    }
  }
  estado.usuarios = usuarios;

  const posts = [];
  for (const e of datos.posts) {
    const p = await descifrarFichero(e);
    if (!p) continue;
    const autor = usuarios.get(p.autor);
    posts.push({ ...p, valido: !!autor && C.verificar(p, autor.signPk) });
  }
  estado.posts = posts.filter((p) => p.valido).sort((a, b) => a.ts - b.ts);

  if (conCorreo) await procesarCorreo();
}

// Busca en el buzón común los mensajes cifrados para mí, los guarda en este ordenador
// y los borra del repositorio: a partir de ese momento sólo existen en los dispositivos.
async function procesarCorreo() {
  const yo = estado.yo;
  if (!yo) return;
  let nuevos = 0;
  for (const e of estado.ultimoListado.correo) {
    if (estado.correoAjeno.has(e.oid)) continue;
    let sobre;
    try { sobre = JSON.parse(e.texto); } catch { estado.correoAjeno.add(e.oid); continue; }
    const m = C.abrir(sobre, yo.boxSk);
    if (!m || m.para !== yo.id) { estado.correoAjeno.add(e.oid); continue; }
    const remitente = estado.usuarios.get(m.de);
    if (!remitente || !C.verificar(m, remitente.signPk)) { estado.correoAjeno.add(e.oid); continue; }
    await Almacen.guardar(yo, {
      id: m.id, con: m.de, conNombre: remitente.nombre, dir: "in", texto: m.texto, ts: m.ts, leido: false,
    });
    nuevos++;
    try { await estado.repo.borrar(`${CARPETAS.correo}/${e.nombre}`, e.oid); } catch { /* se reintentará */ }
    estado.correoAjeno.add(e.oid);
  }
  if (nuevos) estado.mensajes = await Almacen.cargar(yo);
}

async function refrescar() {
  if (estado.sincronizando || !estado.yo) return;
  estado.sincronizando = true;
  try {
    const antes = JSON.stringify([estado.posts.length, estado.usuarios.size, estado.mensajes.length]);
    await sincronizar();
    estado.error = null;
    const despues = JSON.stringify([estado.posts.length, estado.usuarios.size, estado.mensajes.length]);
    if (antes !== despues) pintar();
  } catch (e) {
    estado.error = "No se pudo actualizar: " + e.message;
    pintar();
  } finally {
    estado.sincronizando = false;
  }
}

// ---------- vistas ----------

function hilos() {
  const porHilo = new Map();
  for (const p of estado.posts) {
    if (p.tipo === "hilo") porHilo.set(p.id, { hilo: p, respuestas: [], ultimo: p.ts });
  }
  for (const p of estado.posts) {
    const g = p.tipo === "respuesta" && porHilo.get(p.hilo);
    if (g) { g.respuestas.push(p); g.ultimo = Math.max(g.ultimo, p.ts); }
  }
  return [...porHilo.values()].sort((a, b) => b.ultimo - a.ultimo);
}

function noLeidos() {
  return estado.mensajes.filter((m) => m.dir === "in" && !m.leido).length;
}

const nombreDe = (id) => (estado.usuarios.get(id) || {}).nombre || "desconocido";

function pintar() {
  if (!estado.yo) return;
  const ruta = (location.hash.slice(2) || "foro").split("/");
  const enlaces = [["foro", "Foro"], ["mensajes", "Mensajes"], ["cuenta", "Cuenta"]];
  const pendientes = noLeidos();
  const activo = document.activeElement && document.activeElement.tagName === "TEXTAREA";

  const cabecera = h("header", {},
    h("a", { href: "#/foro", class: "logo pequeno" }, NOMBRE_FORO),
    h("nav", {}, enlaces.map(([r, t]) => h("a", {
      href: "#/" + r,
      class: (ruta[0] === r || (r === "foro" && ["hilo", "nuevo"].includes(ruta[0])) || (r === "mensajes" && ruta[0] === "chat")) ? "activa" : "",
    }, t, r === "mensajes" && pendientes ? h("span", { class: "insignia" }, pendientes) : null))),
    h("span", { class: "yo" }, estado.yo.nombre));

  const vistas = { foro: vistaForo, hilo: vistaHilo, nuevo: vistaNuevo, mensajes: vistaMensajes, chat: vistaChat, cuenta: vistaCuenta };
  const cuerpo = (vistas[ruta[0]] || vistaForo)(ruta[1]);
  pantalla(cabecera, h("main", {}, estado.error && aviso(estado.error), cuerpo));

  if (activo) {
    const t = raiz.querySelector("textarea");
    if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
  }
}

function vistaForo() {
  const lista = hilos();
  return [
    h("div", { class: "barra" }, h("h1", {}, "Hilos"), h("a", { href: "#/nuevo", class: "boton primario" }, "Nuevo hilo")),
    lista.length === 0
      ? h("p", { class: "tenue" }, "Todavía no hay ningún hilo. ¡Abre el primero!")
      : h("ul", { class: "lista" }, lista.map((g) => h("li", {},
          h("a", { href: "#/hilo/" + g.hilo.id, class: "hilo" },
            h("strong", {}, g.hilo.titulo),
            h("span", { class: "tenue" },
              `${nombreDe(g.hilo.autor)} · ${g.respuestas.length} respuesta${g.respuestas.length === 1 ? "" : "s"} · ${fecha(g.ultimo)}`))))),
  ];
}

function publicacion(p) {
  return h("article", { class: "post" },
    h("div", { class: "meta" },
      h("strong", {}, nombreDe(p.autor)),
      h("span", { class: "tenue", title: "Firma verificada" }, "✓ " + fecha(p.ts))),
    h("div", { class: "texto" }, p.cuerpo));
}

async function publicar(datos) {
  const yo = estado.yo;
  const post = C.firmar({ id: fileId(), autor: yo.id, ts: Date.now(), ...datos }, yo.signSk);
  await estado.repo.crear(`${CARPETAS.posts}/${post.id}.json`, await C.cifrar(estado.clave, post), "nueva publicación");
  estado.posts.push({ ...post, valido: true });
  return post;
}

function vistaHilo(id) {
  const g = hilos().find((x) => x.hilo.id === id);
  if (!g) return [aviso("Ese hilo no existe (o aún no se ha cargado).", "info"), h("a", { href: "#/foro" }, "← Volver")];
  const clave = "resp-" + id;
  const area = areaTexto(clave, { maxlength: LIMITES.cuerpo, placeholder: "Escribe tu respuesta…", rows: 4 });
  const enviar = h("button", { type: "submit", class: "primario" }, "Responder");
  const form = h("form", { class: "redactar", onsubmit: async (ev) => {
    ev.preventDefault();
    const cuerpo = area.value.trim();
    if (!cuerpo) return;
    await ocupado(enviar, async () => {
      try {
        await publicar({ tipo: "respuesta", hilo: id, cuerpo });
        delete estado.borradores[clave];
        pintar();
      } catch (e) { form.prepend(aviso("No se pudo publicar: " + e.message)); }
    });
  } }, area, enviar);

  return [
    h("a", { href: "#/foro", class: "volver" }, "← Hilos"),
    h("h1", {}, g.hilo.titulo),
    publicacion(g.hilo),
    g.respuestas.map(publicacion),
    form,
  ];
}

function vistaNuevo() {
  const titulo = h("input", { type: "text", required: true, maxlength: LIMITES.titulo, placeholder: "Título" });
  titulo.value = estado.borradores.nuevoTitulo || "";
  titulo.addEventListener("input", () => { estado.borradores.nuevoTitulo = titulo.value; });
  const area = areaTexto("nuevo", { required: true, maxlength: LIMITES.cuerpo, placeholder: "¿De qué quieres hablar?", rows: 8 });
  const enviar = h("button", { type: "submit", class: "primario" }, "Publicar");
  const form = h("form", { class: "redactar", onsubmit: async (ev) => {
    ev.preventDefault();
    await ocupado(enviar, async () => {
      try {
        const p = await publicar({ tipo: "hilo", titulo: titulo.value.trim(), cuerpo: area.value.trim() });
        delete estado.borradores.nuevo;
        delete estado.borradores.nuevoTitulo;
        location.hash = "#/hilo/" + p.id;
      } catch (e) { form.prepend(aviso("No se pudo publicar: " + e.message)); }
    });
  } }, titulo, area, enviar);
  return [h("a", { href: "#/foro", class: "volver" }, "← Hilos"), h("h1", {}, "Nuevo hilo"), form];
}

function conversaciones() {
  const mapa = new Map();
  for (const m of estado.mensajes) {
    const c = mapa.get(m.con) || { con: m.con, nombre: m.conNombre, ultimo: 0, sinLeer: 0, texto: "" };
    c.ultimo = m.ts; c.texto = m.texto;
    if (m.dir === "in" && !m.leido) c.sinLeer++;
    mapa.set(m.con, c);
  }
  return [...mapa.values()].sort((a, b) => b.ultimo - a.ultimo);
}

function vistaMensajes() {
  const convs = conversaciones();
  const otros = [...estado.usuarios.entries()].filter(([id]) => id !== estado.yo.id)
    .sort((a, b) => a[1].nombre.localeCompare(b[1].nombre));
  const selector = h("select", {}, h("option", { value: "" }, "Escribir a…"),
    otros.map(([id, u]) => h("option", { value: id }, u.nombre)));
  selector.addEventListener("change", () => { if (selector.value) location.hash = "#/chat/" + selector.value; });

  return [
    h("div", { class: "barra" }, h("h1", {}, "Mensajes privados"), selector),
    h("p", { class: "tenue nota" },
      "Los mensajes viajan cifrados de extremo a extremo. En cuanto el destinatario entra, se descargan a su ordenador ",
      "y se borran del servidor: sólo quedan guardados (cifrados) en tu dispositivo y en el suyo."),
    convs.length === 0
      ? h("p", { class: "tenue" }, "No tienes conversaciones en este dispositivo.")
      : h("ul", { class: "lista" }, convs.map((c) => h("li", {},
          h("a", { href: "#/chat/" + c.con, class: "hilo" },
            h("strong", {}, c.nombre, c.sinLeer ? h("span", { class: "insignia" }, c.sinLeer) : null),
            h("span", { class: "tenue recorte" }, `${fecha(c.ultimo)} · ${c.texto}`))))),
  ];
}

function vistaChat(otroId) {
  const otro = estado.usuarios.get(otroId);
  const yo = estado.yo;
  const hilo = estado.mensajes.filter((m) => m.con === otroId);

  const sinLeer = hilo.filter((m) => m.dir === "in" && !m.leido);
  if (sinLeer.length) {
    sinLeer.forEach((m) => { m.leido = true; });
    Promise.all(sinLeer.map((m) => Almacen.guardar(yo, m))).then(() => pintar());
  }

  const nombre = otro ? otro.nombre : (hilo[0] && hilo[0].conNombre) || "desconocido";
  const clave = "chat-" + otroId;
  const area = areaTexto(clave, { maxlength: LIMITES.mensaje, placeholder: otro ? "Mensaje cifrado…" : "Este usuario ya no existe", rows: 3, disabled: !otro });
  const enviar = h("button", { type: "submit", class: "primario", disabled: !otro }, "Enviar");
  const form = h("form", { class: "redactar", onsubmit: async (ev) => {
    ev.preventDefault();
    const texto = area.value.trim();
    if (!texto) return;
    await ocupado(enviar, async () => {
      try {
        const m = C.firmar({ id: fileId(), de: yo.id, para: otroId, texto, ts: Date.now() }, yo.signSk);
        await estado.repo.crear(`${CARPETAS.correo}/${fileId()}.json`, C.sellar(otro.boxPk, m), "correo");
        const local = { id: m.id, con: otroId, conNombre: otro.nombre, dir: "out", texto, ts: m.ts, leido: true };
        await Almacen.guardar(yo, local);
        estado.mensajes.push(local);
        delete estado.borradores[clave];
        pintar();
      } catch (e) { form.prepend(aviso("No se pudo enviar: " + e.message)); }
    });
  } }, area, enviar);

  const borrar = boton("Borrar conversación de este dispositivo", async () => {
    if (!confirm("Se borrará la conversación de este ordenador. No se puede deshacer.")) return;
    await Almacen.borrarConversacion(yo, otroId);
    estado.mensajes = await Almacen.cargar(yo);
    location.hash = "#/mensajes";
  }, { class: "peligro pequeno" });

  return [
    h("a", { href: "#/mensajes", class: "volver" }, "← Mensajes"),
    h("div", { class: "barra" }, h("h1", {}, nombre), hilo.length ? borrar : null),
    h("div", { class: "chat" }, hilo.length === 0
      ? h("p", { class: "tenue" }, "Aún no hay mensajes. El primero que envíes sólo lo podrá leer " + nombre + ".")
      : hilo.map((m) => h("div", { class: "burbuja " + m.dir },
          h("div", { class: "texto" }, m.texto),
          h("span", { class: "tenue" }, fecha(m.ts))))),
    form,
  ];
}

function vistaCuenta() {
  const yo = estado.yo;
  const archivo = h("input", { type: "file", accept: ".json,application/json", hidden: true });
  const resultado = h("div");
  archivo.addEventListener("change", async () => {
    const f = archivo.files[0];
    if (!f) return;
    try {
      const n = await Almacen.importar(yo, await f.text());
      estado.mensajes = await Almacen.cargar(yo);
      resultado.replaceChildren(aviso(`Importados ${n} mensajes.`, "info"));
    } catch (e) { resultado.replaceChildren(aviso(e.message)); }
  });

  const exportar = async () => {
    const blob = new Blob([await Almacen.exportar(yo)], { type: "application/json" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `umbral-${yo.nombre}-copia.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  return [
    h("h1", {}, "Tu cuenta"),
    h("section", { class: "tarjeta" },
      h("p", {}, "Seudónimo: ", h("strong", {}, yo.nombre)),
      h("p", { class: "tenue" }, "Huella de tu clave: ", h("code", {}, b64(yo.signPk).slice(0, 16))),
      h("p", { class: "tenue" }, "Compártela por otro canal si alguien quiere comprobar que eres tú.")),
    h("section", { class: "tarjeta" },
      h("h2", {}, "Mensajes privados en este dispositivo"),
      h("p", {}, `Hay ${estado.mensajes.length} mensajes guardados aquí, cifrados con tu contraseña.`),
      h("p", { class: "tenue" },
        "Tor Browser borra todo lo guardado al cerrarse. Para conservar tus conversaciones, descarga una copia ",
        "cifrada antes de salir e impórtala al volver a entrar. Sólo se puede abrir con tu contraseña."),
      h("div", { class: "acciones" },
        boton("Descargar copia cifrada", exportar, { class: "primario" }),
        boton("Importar copia", () => archivo.click())),
      archivo, resultado),
    h("section", { class: "tarjeta" },
      boton("Cerrar sesión", () => { location.hash = ""; location.reload(); }, { class: "peligro" })),
  ];
}

iniciar();
