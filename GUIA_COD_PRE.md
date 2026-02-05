# Guía: COD PRE y Código Producto con 5 Dígitos

## ✅ Cambios Realizados

### 1. Formateo Automático a 5 Dígitos
- **COD PRE**: Ahora se formatea automáticamente (ej: `1` → `00001`, `123` → `00123`)
- **Código Producto**: También se formatea a 5 dígitos (ej: `91` → `00091`, `2` → `00002`)

### 2. Carga del Mapa COD PRE al Inicio
- El archivo `catalogo-redes.xlsx` se carga al iniciar la aplicación
- El mapa se guarda en `window.mapaCodPre` para uso global

### 3. Envío a Google Sheets
- Los valores formateados se envían al Apps Script
- El Apps Script los guarda en la hoja "ENTRADAS"

## 📋 Requisitos

### Archivo `catalogo-redes.xlsx`
Debe estar en la misma carpeta que `index.html` y tener:

**Columnas requeridas:**
- Una columna con nombre que incluya: `ESTABLECIMIENTO`, `CENTRO` o `ESTABLE`
- Una columna con nombre que incluya: `COD PRE`, `CODPRE` o `COD`

**Ejemplo:**
| ESTABLECIMIENTO | COD PRE |
|-----------------|---------|
| C.S. MARQUEZ    | 1       |
| P.S. ANGAMOS    | 2       |
| HOSPITAL CENTRAL| 123     |

El sistema automáticamente:
- Encuentra las columnas correctas
- Lee los valores
- Formatea los códigos a 5 dígitos
- Los usa cuando guardas registros

## 🔍 Verificación

### En la Consola del Navegador (F12):
Deberías ver al cargar la página:
```
✓ Mapa COD PRE cargado: X establecimientos
```

Si ves:
```
No se pudo cargar catalogo-redes.xlsx para COD PRE
```
Significa que el archivo no existe o está en la ubicación incorrecta.

### Al Guardar un Registro:
1. Abre la consola (F12)
2. Guarda un registro
3. Verifica que en el payload enviado:
   - `cod_pre` tenga 5 dígitos (ej: "00001")
   - `codigo_producto` tenga 5 dígitos (ej: "00091")

## 🛠️ Solución de Problemas

### COD PRE aparece vacío
**Causa:** El nombre del establecimiento no coincide con el del catálogo

**Solución:**
1. Verifica que el nombre en `catalogo-redes.xlsx` sea exactamente igual
2. La comparación es en MAYÚSCULAS, así que "P.S. Angamos" = "P.S. ANGAMOS"
3. Revisa espacios extra o caracteres especiales

### Código de Producto no se formatea
**Causa:** El formato del producto no se reconoce

**Solución:**
El producto debe estar en uno de estos formatos:
- `[91] ACIDO ACETILSALICILICO`
- `91 ACIDO ACETILSALICILICO`
- `91-ACIDO ACETILSALICILICO`

### Verificar el Mapa COD PRE
Ejecuta en la consola:
```javascript
console.log(window.mapaCodPre);
```

Deberías ver algo como:
```javascript
{
  "C.S. MARQUEZ": "1",
  "P.S. ANGAMOS": "2",
  ...
}
```

## 📊 Resultado Esperado en Google Sheets

Después de guardar, la hoja debe mostrar:

| COD PRE | Establecimiento | Código Product | Producto | ... |
|---------|-----------------|----------------|----------|-----|
| 00001   | C.S. MARQUEZ    | 00091          | ACIDO... | ... |
| 00002   | P.S. ANGAMOS    | 00002          | ABACAVIR | ... |

## 🔧 Apps Script (código en Google Apps Script)

Asegúrate de que tu Apps Script tenga este código:

```javascript
const SHEET_ID = "1wXQjHUAHEnfTde4xWJujv9xMQOmbGgzaI_27rRnUOQM";
const SHEET_NAME = "ENTRADAS";

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sh = ss.getSheetByName(SHEET_NAME);

    if (!sh) {
      sh = ss.insertSheet(SHEET_NAME);
      const headers = [
        "COD PRE", "Establecimiento", "Código Producto", "Producto",
        "Tipo de Servicio", "Cantidad Requerida", "Cantidad Disponible",
        "Demanda No Satisfecha", "Cobertura (%)", "Fecha",
        "Observaciones", "Usuario que Registró", "Fecha de Registro"
      ];
      sh.appendRow(headers);
    }

    const row = [
      data.cod_pre || '',
      data.establecimiento || '',
      data.codigo_producto || '',
      data.producto || '',
      data.tipo_servicio || '',
      Number(data.cantidad_requerida) || 0,
      Number(data.cantidad_disponible) || 0,
      Number(data.demanda_no_satisfecha) || 0,
      Number(data.porcentaje_cobertura) || 0,
      data.fecha_registro || '',
      data.observaciones || '',
      data.usuario_registra || '',
      data.fecha_registro_sistema || new Date().toISOString(),
    ];

    sh.appendRow(row);

    return ContentService
      .createTextOutput(JSON.stringify({ status: 'ok' }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    Logger.log("Error: " + error);
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'error', message: error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
```

## ✨ Características Adicionales

- **Formato automático**: Los códigos siempre tendrán 5 dígitos
- **Compatibilidad**: Si el código ya tiene 5+ dígitos, no se modifica
- **Sin errores**: Si no hay COD PRE en el catálogo, simplemente queda vacío
- **Fallback CORS**: Si el primer intento falla, se intenta con `no-cors`
