// Toda la criptografía del foro.
//  - Contenido del foro: AES-256-GCM con una clave derivada de la frase de acceso del foro.
//  - Identidad de cada usuario: claves Ed25519 (firma) y X25519 (cifrado) derivadas
//    de seudónimo + contraseña, así funcionan en cualquier ordenador sin guardar nada.
//  - Mensajes privados: cifrado extremo a extremo (nacl.box con clave efímera).
import { utf8, fromUtf8, b64, unb64, hex, random, canonical } from "./util.js";

const nacl = globalThis.nacl;
const subtle = crypto.subtle;
export const ITERACIONES = 600000;

async function pbkdf2(secret, salt, iter, bytes) {
  const base = await subtle.importKey("raw", utf8(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, base, bytes * 8);
  return new Uint8Array(bits);
}

const aesKey = (raw) => subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);

export async function claveForo(frase, saltB64, iter = ITERACIONES) {
  const raw = await pbkdf2(frase, unb64(saltB64), iter, 32);
  return aesKey(raw);
}

export async function cifrar(key, obj) {
  const iv = random(12);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, utf8(JSON.stringify(obj)));
  return { v: 1, iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

export async function descifrar(key, sobre) {
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: unb64(sobre.iv) }, key, unb64(sobre.ct));
  return JSON.parse(fromUtf8(new Uint8Array(pt)));
}

export const normalizarNombre = (n) => n.normalize("NFC").trim();
export const NOMBRE_VALIDO = /^[\p{L}\p{N}_.\-]{3,24}$/u;

export async function idUsuario(nombre, saltForo) {
  const d = await subtle.digest("SHA-256", utf8(saltForo + "|" + normalizarNombre(nombre).toLowerCase()));
  return hex(new Uint8Array(d)).slice(0, 32);
}

export async function identidad(nombre, password, saltForo, iter = ITERACIONES) {
  const salt = utf8("umbral-id-v1|" + saltForo + "|" + normalizarNombre(nombre).toLowerCase());
  const m = await pbkdf2(password, salt, iter, 96);
  const firma = nacl.sign.keyPair.fromSeed(m.slice(0, 32));
  const caja = nacl.box.keyPair.fromSecretKey(m.slice(32, 64));
  return {
    nombre: normalizarNombre(nombre),
    id: await idUsuario(nombre, saltForo),
    signPk: firma.publicKey, signSk: firma.secretKey,
    boxPk: caja.publicKey, boxSk: caja.secretKey,
    claveLocal: await aesKey(m.slice(64, 96)),
  };
}

const sinFirma = (obj) => { const { sig, ...resto } = obj; return resto; };

export function firmar(obj, signSk) {
  const sig = nacl.sign.detached(utf8(canonical(sinFirma(obj))), signSk);
  return { ...obj, sig: b64(sig) };
}

export function verificar(obj, signPkB64) {
  try {
    return nacl.sign.detached.verify(utf8(canonical(sinFirma(obj))), unb64(obj.sig), unb64(signPkB64));
  } catch { return false; }
}

// Cifra para un destinatario con una clave efímera: el sobre no revela quién lo envía.
export function sellar(boxPkB64, obj) {
  const eph = nacl.box.keyPair();
  const n = random(nacl.box.nonceLength);
  const c = nacl.box(utf8(JSON.stringify(obj)), n, unb64(boxPkB64), eph.secretKey);
  return { v: 1, epk: b64(eph.publicKey), n: b64(n), c: b64(c) };
}

export function abrir(sobre, boxSk) {
  try {
    const pt = nacl.box.open(unb64(sobre.c), unb64(sobre.n), unb64(sobre.epk), boxSk);
    return pt ? JSON.parse(fromUtf8(pt)) : null;
  } catch { return null; }
}
