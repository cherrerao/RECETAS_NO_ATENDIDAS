# Solución: Códigos de Establecimiento en Excel

## Problema
El código del establecimiento "P.S. SANTA ROSA DE PACHACUTEC" (06263) no aparecía en el Excel descargado, aunque estaba en los datos.

## Causa
El código intentaba cargar el mapa de códigos (`COD PRE`) desde un archivo Excel inexistente (`catalogo-redes.xlsx`). Como no lo encontraba, el mapa quedaba vacío y los códigos no se mostraban en la exportación.

## Solución
Se actualizó el código para usar directamente el archivo JSON `catalogo_establecimientos.json` que ya contiene todos los códigos correos. Se realizaron 3 cambios:

### 1. **cargarMapaCodPreGlobal()** (línea ~318)
   - Ahora carga desde `catalogo_establecimientos.json` en lugar de `catalogo-redes.xlsx`
   - Normaliza los nombres de establecimientos de forma consistente

### 2. **exportarResumenExcel()** (línea ~2290)
   - Actualizada para usar el JSON en lugar del Excel
   - Mantiene la misma lógica de normalización

### 3. **exportarResumenExcel()** - Sección de estadísticas (línea ~2517)
   - Actualizada para usar el JSON
   - Consistencia con las otras funciones

## Normalización
Todos los nombres se normalizan del mismo modo:
- Mayúsculas: `P.S. SANTA ROSA DE PACHACUTEC` → `P.S. SANTA ROSA DE PACHACUTEC`
- Sin puntos: → `PS SANTA ROSA DE PACHACUTEC`
- Sin espacios múltiples: → `PS SANTA ROSA DE PACHACUTEC`
- Guiones normalizados

Esto garantiza que la búsqueda funcione correctamente.

## Resultado
✓ El código 06263 ahora aparecerá en el Excel para "P.S. SANTA ROSA DE PACHACUTEC"
✓ Todos los 80+ establecimientos del catálogo tienen sus códigos disponibles
✓ El sistema es más eficiente al no depender de archivos externos
