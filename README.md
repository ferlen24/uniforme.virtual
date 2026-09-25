# Uniforme Virtual

Juego web para verse con el uniforme del I.E.S.P. Ntra. Sra. del Carmen.

- Elegí uniforme de **Hombre** o **Mujer** y escribí tu apellido (aparece en la placa).
- La cámara detecta el rostro en vivo y acomoda la gorra y la chaqueta reales (recortadas de fotos, en `assets/`) sobre la persona.
- Sacá la foto (con la cámara frontal hay cuenta regresiva de 3 segundos) o elegí una de la galería.
- En el resultado podés arrastrar para acomodar, cambiar el tamaño y guardar o compartir la foto.

Todo se procesa en el teléfono: las fotos no se suben a ningún servidor.
La detección de rostro usa MediaPipe (se descarga desde CDN la primera vez); sin conexión,
el uniforme se ubica según el óvalo guía y se puede ajustar a mano.

La cámara sólo funciona desde `https://` (por ejemplo GitHub Pages) o `localhost`.
