# X-PAD (estilo RMX-1000) para iPad

Web app para Safari. Una vez instalada en la pantalla de inicio funciona sin internet.
Salida: minijack del iPad → cable minijack‑RCA → entrada LINE de un canal de la Xone:96.

## Cómo se toca
- **Pad**: un golpe. Al volver a disparar el mismo pad se corta el anterior, como en el hardware.
- **Roll**: mantén un pad y arrastra el dedo hasta la tira ROLL · BEAT. Desliza por la tira para cambiar entre 1/1 y 1/16, vuelve al pad o suelta para parar.
- **Roll con dos dedos**: mantén uno o varios pads y toca la tira con otro dedo. Si tocas solo la tira, hace roll del último pad (el que tiene el LED azul).
- **TAP**: marca 4–8 golpes al ritmo del tema. Fija el BPM y la fase (el primer tiempo).
- **− / +**: ajuste de ±0,1 BPM; si lo mantienes, se repite.
- **NUDGE ◀ ▶**: un toque mueve la fase 5 ms; si lo mantienes, la va desplazando poco a poco (como el pitch bend de un CDJ).
- **QUANTIZE ON**: los rolls caen en la rejilla del BPM. Con OFF arrancan en el momento en que tocas.
- **PITCH / DECAY**: arrastra arriba o abajo. Con doble toque vuelven al valor por defecto.
- **VOLUME**: 0 dB a las 3 en punto, hasta +6 dB. Hay un limitador en la salida para que no sature.

Los ajustes se guardan en el iPad.

## Publicarla (una sola vez)
Safari solo permite el modo offline si la app se sirve por HTTPS.

**GitHub Pages**
1. Crea un repositorio en github.com (puede ser privado si tienes GitHub Pro; si no, público).
2. Sube el contenido de esta carpeta (Add file → Upload files).
3. Settings → Pages → Branch: `main`, carpeta `/ (root)` → Save.
4. Al cabo de un minuto estará en `https://TU-USUARIO.github.io/NOMBRE-REPO/`.

**Netlify (alternativa)**: entra en app.netlify.com/drop con tu cuenta y arrastra esta carpeta.

## Instalarla en el iPad
1. Abre la URL en Safari.
2. Compartir → **Añadir a pantalla de inicio**.
3. Ábrela desde el icono una vez con internet, para que guarde los sonidos. A partir de ahí funciona sin conexión.

## Antes de pinchar
- Volumen del iPad al máximo y ganancia del canal de la Xone a 0; ajusta el nivel con el knob VOLUME de la app.
- Activa el modo avión para que no entren notificaciones por la salida.
- Si iPadOS pausa el audio (llamada, Siri…), la app muestra ON otra vez: tócalo.

## Cambiar algo
- Sonidos: sustituye los WAV de `samples/` (mismos nombres).
- Después de cambiar cualquier archivo, sube el número de `CACHE` en `sw.js` (`xpad-v2`, …) para que el iPad descargue la versión nueva.

Probar en el Mac: `python3 -m http.server 8765` dentro de esta carpeta y abre http://localhost:8765.
