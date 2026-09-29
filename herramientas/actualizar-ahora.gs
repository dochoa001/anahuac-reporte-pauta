/**
 * Botón "Actualizar" del reporte → dispara el workflow de GitHub en ese momento.
 *
 * Por qué existe: la página vive en GitHub Pages (estática) y no puede guardar un token.
 * Este Apps Script guarda el token de GitHub y solo acepta la clave que viaja dentro del
 * reporte cifrado (así, solo quien entró con la contraseña puede pedir una actualización).
 *
 * Instalación (5 minutos):
 *  1. script.google.com → Nuevo proyecto → pega este archivo.
 *  2. Configuración del proyecto → Propiedades del script:
 *       GITHUB_TOKEN  token "fine-grained" con acceso SOLO a este repositorio y permiso
 *                     "Actions: Read and write" (nada más).
 *       REPO          dueño/repositorio, p. ej. dochoa001/anahuac-reporte-pauta
 *       CLAVE         una cadena larga al azar (la misma que el secreto DISPATCH_KEY del repo)
 *  3. Implementar → Nueva implementación → Aplicación web.
 *       Ejecutar como: yo · Quién tiene acceso: cualquier persona.
 *  4. Copia la URL /exec y guárdala en el repo como variable DISPATCH_URL.
 */
function doPost(e) {
  var props = PropertiesService.getScriptProperties();
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (x) {}
  if (!body.clave || body.clave !== props.getProperty('CLAVE')) return salida('clave no válida');

  // Máximo una actualización cada 5 minutos, pida quien la pida.
  var cache = CacheService.getScriptCache();
  if (cache.get('reciente')) return salida('ya hay una actualización en curso');
  cache.put('reciente', '1', 300);

  var url = 'https://api.github.com/repos/' + props.getProperty('REPO') + '/actions/workflows/actualizar.yml/dispatches';
  var r = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + props.getProperty('GITHUB_TOKEN'),
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    payload: JSON.stringify({ ref: 'main' })
  });
  return salida(r.getResponseCode() === 204 ? 'ok' : 'error ' + r.getResponseCode());
}

function salida(texto) {
  return ContentService.createTextOutput(texto).setMimeType(ContentService.MimeType.TEXT);
}
