# Reporte vivo: leads de pauta vs HubSpot

Página que muestra, por proveedor de pauta, si cada lead de su base **ya es contacto en HubSpot** y si **tiene su negocio**. Sirve para encontrar los negocios que el workflow no creó y los contactos desfasados.

- **Portada:** una tarjeta por proveedor con sus leads, % en HubSpot, % con negocio a tiempo y casos por resolver.
- **Detalle por proveedor:** filtros de periodo, semana/mes y programa. Incluye una gráfica por periodo, una tabla por programa y la lista de casos, con enlace al contacto o negocio en HubSpot y descarga en CSV.
- **Se actualiza sola cada hora.** El botón *Actualizar* busca la versión más reciente. Si está configurado el paso opcional 5, además pide una actualización en ese momento.

## Cómo funciona

| Pieza | Qué hace | Dónde |
|---|---|---|
| Bases de proveedores | Un Google Sheet vivo por proveedor (el export de Meta) | Google Drive |
| Motor (`src/`) | Lee los Sheets y busca cada correo en HubSpot (contacto, negocios asociados, etapa y propietario). Después aplica las reglas y **cifra** el resultado | GitHub Actions, cada hora |
| Página (`public/index.html`) | Pide la contraseña, descifra el reporte en el navegador y lo dibuja | GitHub Pages |

GitHub Pages es **público**, así que el reporte se publica cifrado (AES-256-GCM, con una llave derivada de la contraseña mediante PBKDF2). Sin la contraseña, `data.enc.json` no se puede leer. En el repositorio no hay datos ni claves: la configuración y los secretos viven en *Settings → Secrets and variables → Actions*.

HubSpot se lee **solo en modo lectura**. El motor no escribe nada en el portal.

## Estatus de cada lead

| Estatus | Regla |
|---|---|
| Negocio a tiempo | Hay un negocio **del mismo programa** creado dentro de las `ventanaNegocioHoras` (48 h) siguientes al lead |
| Negocio tardío | El negocio del programa existe, pero se creó después de las 48 h |
| Ya tenía negocio | El contacto ya tenía un negocio de ese programa desde antes del lead, así que no se abrió otro |
| Sin negocio | El contacto existe, pero no tiene ningún negocio de ese programa. Estos son los pendientes |
| Sin contacto | El correo no existe en HubSpot, ni como principal ni como secundario |
| *Desfasado* (bandera) | El contacto se creó más de `desfaseMin` (60 min) después del lead |

**¿De dónde sale el programa del lead?** Se busca en este orden:

1. La columna *Programa* de la base.
2. `programaPorFormulario` o `programaPorPestana` de la configuración.
3. El nombre del formulario o de la campaña.
4. El programa que HubSpot les asignó a los contactos nuevos de ese mismo formulario (por mayoría).

El programa se compara contra la propiedad `1.0 Posgrado de interés` del negocio.

## Puesta en marcha

Los pasos 1 a 3 los hace una persona de B&O. Las claves nunca pasan por un chat ni por el código.

1. **HubSpot: clave de solo lectura.** Se crea una *app privada* (o una *clave de servicio*) en el portal con estos alcances y nada más:

   `crm.objects.contacts.read`, `crm.objects.deals.read`, `crm.schemas.contacts.read`, `crm.schemas.deals.read`, `crm.objects.owners.read`

   El token se guarda como secreto **`HUBSPOT_TOKEN`**.
2. **Google: cuenta de servicio.**
   - En console.cloud.google.com se crea un proyecto, se habilita la *Google Sheets API* y se crea una *cuenta de servicio* con una clave JSON.
   - El JSON completo se guarda como secreto **`GOOGLE_SA_JSON`**.
   - Cada Sheet de proveedor se comparte con el correo de la cuenta de servicio (`…@….iam.gserviceaccount.com`) como **Lector**.
3. **Contraseña del reporte.** Se elige una frase larga (12 caracteres o más) y se guarda como secreto **`REPORT_PASSWORD`**. Es la que se comparte con el cliente.
4. **Configuración.** La variable **`REPORT_CONFIG`** lleva el JSON de proveedores y reglas (ver `config.example.json`). Si se edita la variable, se vuelve a correr el workflow para aplicar el cambio.
5. *(Opcional)* **Botón "Actualizar ahora".** Se instala `herramientas/actualizar-ahora.gs` como aplicación web de Apps Script. Su URL se guarda como variable **`DISPATCH_URL`** y su clave como secreto **`DISPATCH_KEY`**.

Después se corre el workflow: *Actions → Actualizar reporte → Run workflow*.

## Agregar un proveedor

1. El proveedor comparte su Google Sheet con la cuenta de servicio.
2. En `REPORT_CONFIG`, a su entrada se le pone `"fuente": { "tipo": "sheet", "id": "<ID del Sheet>" }`.

El motor reconoce dos formatos de base:

- El export estándar de Meta, con encabezado (`id`, `created_time`, `form_id`, `email`…).
- Un repositorio como el de Grupo Nods, sin encabezado útil y con prefijos `l:`, `f:`, `c:`, `p:`.

Las fechas sin zona horaria se leen como `zonaSinOffset` (por defecto `-06:00`, CDMX).

## Correr en local (con el proxy de B&O)

```powershell
$env:HUBSPOT_BASE_URL = 'http://127.0.0.1:8787/AnahuacPosgrados'   # el proxy pone la clave
$env:REPORT_PASSWORD  = 'contraseña-de-prueba-local'
node src/motor.mjs --config config.local.json --out _local/dist/data.enc.json
```

`--plain archivo.json` escribe además una copia **sin cifrar**, solo para revisión local. Contiene datos personales y nunca se sube. `.gitignore` ya excluye `_local/`, `dist/` y `*.plain.json`.

## Límites conocidos

- **Frecuencia:** el cron de GitHub corre cada hora y a veces se retrasa unos minutos.
- **Inactividad:** en repos públicos, GitHub apaga los workflows programados tras 60 días sin actividad. El job `mantener-activo` lo reactiva una vez al día; aun así, si llega el correo de aviso de GitHub, basta con volver a correr el workflow.
- **Rotar la contraseña:** se cambia `REPORT_PASSWORD` y se corre el workflow. Quien tenga la página abierta tendrá que escribir la nueva.
- **Búsqueda por correo secundario:** se hace hasta con 200 correos no encontrados por corrida (`maxBusquedasSecundarias`).
