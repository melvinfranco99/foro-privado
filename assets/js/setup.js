// Configuración inicial del foro (sólo la usa quien administra el repositorio).
// Guarda en config.json el token de GitHub cifrado con la frase de acceso del foro.
import { Repo } from "./github.js";
import * as C from "./cripto.js";
import { b64, unb64, random, utf8, fromUtf8 } from "./util.js";

const $ = (id) => document.getElementById(id);
const form = $("setup");
const salida = $("salida");

// En GitHub Pages la URL es https://<usuario>.github.io/<repo>/
const [usuarioPages] = location.hostname.split(".");
$("owner").value = location.hostname.endsWith("github.io") ? usuarioPages : "";
$("repo").value = location.pathname.split("/").filter(Boolean)[0] || "";

function mostrar(texto, tipo) {
  salida.className = "aviso " + tipo;
  salida.textContent = texto;
}

async function crearRamaDatos(repo) {
  const base = `/repos/${repo.owner}/${repo.repo}`;
  try {
    await repo.peticion("GET", `${base}/branches/${repo.branch}`);
    return false;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  const leeme = "Datos cifrados del foro. No edites esta rama a mano.\n";
  const tree = await repo.peticion("POST", `${base}/git/trees`, {
    tree: ["README.md", "foro/posts/.keep", "foro/usuarios/.keep", "correo/.keep"].map((path) => ({
      path, mode: "100644", type: "blob", content: path === "README.md" ? leeme : "",
    })),
  });
  const firma = { name: "umbral", email: "foro@umbral.invalid" };
  const commit = await repo.peticion("POST", `${base}/git/commits`, {
    message: "Inicio de los datos del foro", tree: tree.sha, parents: [], author: firma, committer: firma,
  });
  await repo.peticion("POST", `${base}/git/refs`, { ref: `refs/heads/${repo.branch}`, sha: commit.sha });
  return true;
}

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const btn = form.querySelector("button");
  btn.disabled = true;
  try {
    const frase = $("frase").value;
    if (frase.length < 16) throw new Error("La frase de acceso debe tener al menos 16 caracteres.");
    if (frase !== $("frase2").value) throw new Error("Las frases de acceso no coinciden.");

    const datos = { owner: $("owner").value.trim(), repo: $("repo").value.trim(), branch: "datos" };
    const token = $("token").value.trim();
    const repo = new Repo(datos, token);
    const base = `/repos/${datos.owner}/${datos.repo}`;

    mostrar("Comprobando el token…", "info");
    const info = await repo.peticion("GET", base);
    const principal = info.default_branch;

    let actual = null;
    try {
      actual = await repo.peticion("GET", `${base}/contents/config.json?ref=${principal}`);
    } catch (e) { if (e.status !== 404) throw e; }

    let cfg;
    if (actual) {
      // Renovación del token: se conserva la sal para no perder los datos existentes.
      const previo = JSON.parse(fromUtf8(unb64(actual.content.replace(/\n/g, ""))));
      mostrar("Ya existe una configuración: comprobando la frase…", "info");
      const clave = await C.claveForo(frase, previo.salt, previo.iter);
      try { await C.descifrar(clave, previo.check); } catch {
        throw new Error("La frase no coincide con la del foro existente. Usa la misma frase para renovar el token.");
      }
      cfg = { ...previo, ...datos, token: await C.cifrar(clave, token) };
    } else {
      mostrar("Derivando la clave del foro…", "info");
      const salt = b64(random(16));
      const clave = await C.claveForo(frase, salt, C.ITERACIONES);
      cfg = {
        v: 1, ...datos, salt, iter: C.ITERACIONES,
        check: await C.cifrar(clave, "umbral-ok"),
        token: await C.cifrar(clave, token),
      };
    }

    mostrar("Preparando la rama de datos…", "info");
    await crearRamaDatos(repo);

    mostrar("Guardando config.json…", "info");
    await repo.peticion("PUT", `${base}/contents/config.json`, {
      message: actual ? "Renovar token del foro" : "Configurar foro",
      content: b64(utf8(JSON.stringify(cfg, null, 2) + "\n")),
      branch: principal,
      ...(actual ? { sha: actual.sha } : {}),
    });

    form.reset();
    mostrar("¡Listo! GitHub Pages tarda uno o dos minutos en publicar el cambio. Después, abre el foro desde Tor Browser y crea tu cuenta.", "ok");
  } catch (e) {
    mostrar("Error: " + e.message, "error");
  } finally {
    btn.disabled = false;
  }
});
