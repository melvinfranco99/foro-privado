# Umbral: foro privado

Un foro privado sin servidor, alojado en GitHub Pages, que usa este mismo repositorio como base de datos.

## Cómo funciona

| Pieza | Dónde vive | Quién puede leerla |
|---|---|---|
| Código de la web | rama `main` (GitHub Pages) | cualquiera, es público |
| Hilos, respuestas y lista de usuarios | rama `datos`, cifrados con AES-256-GCM | sólo quien conoce la **frase de acceso del foro** |
| Mensajes privados en tránsito | rama `datos/correo`, cifrados de extremo a extremo (X25519 + XSalsa20-Poly1305) | sólo el destinatario |
| Mensajes privados entregados | IndexedDB del navegador del emisor y del receptor, cifrados con su contraseña | sólo su dueño |
| Token de GitHub para escribir | `config.json`, cifrado con la frase de acceso | sólo los miembros |

- **Cuentas con seudónimo.** No hay correo ni datos personales. De seudónimo + contraseña se derivan (PBKDF2, 600 000 iteraciones) las claves de firma (Ed25519) y de cifrado (X25519) de cada persona. Por eso funciona en cualquier ordenador sin guardar nada.
- **Todo va firmado.** Cada publicación y cada mensaje privado se firma con la clave del autor. La web descarta lo que no tenga una firma válida, así que nadie puede publicar en nombre de otro.
- **Mensajes privados.** El emisor cifra el mensaje con la clave pública del destinatario y lo deja en el buzón común (`correo/`). Cuando el destinatario entra, su navegador lo descarga, lo guarda cifrado en su ordenador y **lo borra del repositorio**. El emisor guarda su copia sólo en su ordenador. El sobre no indica ni quién lo envía ni a quién va.
- **Sólo por Tor.** Al abrir la web se comprueba que el navegador es Tor Browser y que la IP de salida pertenece a la red Tor (directorio público Onionoo). Si no, se bloquea el acceso antes de hacer ninguna petición.

## Puesta en marcha (una sola vez)

1. Crea un *fine-grained token* en GitHub con acceso **sólo a este repositorio** y el permiso **Contents: Read and write**.
2. Abre `https://<usuario>.github.io/foro-privado/setup.html`, pega el token y elige la frase de acceso del foro.
3. Pasa la dirección y la frase a los miembros por un canal seguro.

El token caduca, como mucho, al año: repite el paso 2 con la **misma frase** para renovarlo.

## Límites conocidos (es un prototipo)

- **El bloqueo de Tor se hace en el navegador.** GitHub Pages no puede rechazar conexiones, así que alguien con conocimientos técnicos podría saltárselo. Lo que de verdad protege el contenido es el cifrado. Para que *sólo* exista dentro de Tor hace falta un servicio `.onion`, que necesita una máquina encendida (una Raspberry Pi en casa vale).
- **Tor Browser borra el almacenamiento al cerrarse.** Para conservar los mensajes privados, descarga la copia cifrada desde *Cuenta* antes de salir e impórtala al volver. También puedes desactivar el modo privado permanente de Tor Browser, aunque reduce el anonimato.
- **Los miembros comparten el token de escritura.** Un miembro malicioso podría borrar ficheros (el historial de git permite recuperarlos), pero no leer mensajes privados ajenos ni suplantar firmas.
- **El historial de git conserva los sobres cifrados** aunque se borren del buzón. Sin la contraseña del destinatario son ilegibles.
- **El repositorio es público** (GitHub Pages gratuito lo exige). Se ven el número de ficheros y las horas de actividad, no su contenido.
