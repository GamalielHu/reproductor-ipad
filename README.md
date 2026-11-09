# Reproductor de video para iPad (PWA)

Reproductor web para Safari en iPadOS: OneDrive (Microsoft Graph), enlaces directos/HLS y archivos del iPad.

**App:** https://gamalielhu.github.io/reproductor-ipad/

## Estructura

```
index.html              Interfaz (biblioteca + reproductor), meta tags PWA de Apple
styles.css              Estilos (CSS Grid/Flexbox, áreas seguras del iPad)
config.js               Client ID de Azure, autoridad, scopes y CDNs
manifest.webmanifest    Manifiesto PWA
sw.js                   Service worker (caché de la app; nunca guarda video)
js/app.js               Pestañas, historial, menús, Media Session, ajustes
js/player.js            Motor: hls.js, calidad, velocidad, aspecto, PiP, audio, subtítulos, volumen por Web Audio
js/gestures.js          Gestos táctiles
js/onedrive-service.js  MSAL.js v2 + Microsoft Graph (carpetas, búsqueda, enlaces compartidos, subtítulos)
js/storage.js           Historial y ajustes en localStorage
js/subtitles.js         Conversión SRT → VTT
icons/                  Iconos (incluye apple-touch-icon)
.github/workflows/pages.yml  Publica en GitHub Pages en cada push a main
vercel.json             Alternativa: desplegar en Vercel sin cambios
```

## Gestos

| Gesto | Acción |
|---|---|
| Toque | Mostrar/ocultar controles |
| Doble toque izquierda / derecha | −10 s / +10 s (cada toque extra suma 10 s) |
| Doble toque centro | Reproducir / pausa |
| Deslizar horizontal | Avanzar / retroceder con vista previa |
| Deslizar vertical mitad izquierda | Brillo |
| Deslizar vertical mitad derecha | Volumen |
| Pellizcar abrir / cerrar | Recortar / ajustar imagen |

En iPad, Safari no deja cambiar `video.volume`; el volumen por gesto usa Web Audio y funciona con OneDrive, archivos locales, HLS y enlaces con CORS. En enlaces sin CORS se usan los botones del iPad.

## Conectar OneDrive (una sola vez)

1. Entra a https://entra.microsoft.com → **Registros de aplicaciones** → **Nuevo registro**.
2. Nombre: `Reproductor iPad`. Tipos de cuenta: **Cuentas en cualquier directorio organizativo y cuentas personales de Microsoft**.
3. URI de redirección: plataforma **Aplicación de página única (SPA)** → `https://gamalielhu.github.io/reproductor-ipad/`.
4. **Registrar** y copia el **Id. de aplicación (cliente)**.
5. En **Permisos de API** deja `User.Read` y agrega Microsoft Graph → Delegados → `Files.Read.All`.
6. En la app: ⚙️ Ajustes → pega el ID → Guardar. (O ponlo en `config.js`, campo `oneDriveClientId`.)

## Formatos en iPad

MP4/MOV/M4V (H.264, HEVC), WebM y HLS `.m3u8`. Safari no reproduce MKV/AVI/WMV.
Calidad 1080p/720p/480p/Auto aparece con HLS adaptativo; un MP4 tiene una sola calidad.

## Instalar en el iPad

Abrir la URL en Safari → Compartir → **Agregar a pantalla de inicio**.

## Desarrollo

Sin build. Servir la carpeta con cualquier servidor estático (`npx serve .`). MSAL exige `https` o `localhost`.
