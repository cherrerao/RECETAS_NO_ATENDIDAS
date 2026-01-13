// ============================================================
// GOOGLE APPS SCRIPT COMPLETO - GESTIÓN DE USUARIOS Y RECETAS
// ============================================================
// Reemplaza el contenido de Code.gs en tu proyecto Apps Script con este código
// ID de hoja: 1wXQjHUAHEnfTde4xWJujv9xMQOmbGgzaI_27rRnUOQM

const SHEET_ID = '1wXQjHUAHEnfTde4xWJujv9xMQOmbGgzaI_27rRnUOQM';
const SHEET_USUARIOS = 'USUARIOS';
const SHEET_RECETAS = 'RECETAS';
const SHEET_ENTRADAS = 'ENTRADAS'; // Compatibilidad con código existente
const TIMEZONE_PERU = 'America/Lima'; // UTC-5

// Función para obtener fecha/hora actual en zona horaria de Perú
function obtenerFechaHoraPeru() {
  return Utilities.formatDate(new Date(), TIMEZONE_PERU, 'yyyy-MM-dd\'T\'HH:mm:ss');
}

// ============================================================
// FUNCIONES PRINCIPALES (doGet y doPost)
// ============================================================

function doGet(e) {
  const params = e.parameter;
  const action = params.action;
  
  try {
    switch(action) {
      case 'getUsers':
        return obtenerUsuarios();
      case 'getRecetas':
        // Devolver TODAS las recetas sin filtrar
        // El filtrado se hace en JavaScript
        return obtenerRecetas();
      default:
        return respuestaJSON({
          status: 'error',
          message: 'Acción GET no reconocida: ' + action
        });
    }
  } catch (error) {
    return respuestaJSON({
      status: 'error',
      message: 'Error en doGet: ' + error.toString()
    });
  }
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const action = data.action;
    
    switch(action) {
      case 'getUsers':
        return obtenerUsuarios();
      
      case 'getRecetas':
        return obtenerRecetas();
      
      case 'createUser':
        return crearUsuario(data.usuario);
      
      case 'deleteReceta':
        return eliminarReceta(data.id);
      
      case 'deleteAllRecetas':
        return limpiarTodasLasRecetas();
      
      // Compatibilidad con registros de recetas antiguos
      case 'saveReceta':
        return guardarReceta(data);
      
      default:
        // Si viene con establecimiento y producto, es un registro de receta
        if (data.establecimiento && data.producto) {
          return guardarReceta(data);
        }
        
        return respuestaJSON({
          status: 'error',
          message: 'Acción POST no reconocida: ' + action
        });
    }
    
  } catch (error) {
    console.error('Error en doPost:', error);
    return respuestaJSON({
      status: 'error',
      message: error.toString()
    });
  }
}

// ============================================================
// FUNCIONES DE USUARIOS
// ============================================================

function obtenerUsuarios() {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sheet = ss.getSheetByName(SHEET_USUARIOS);
    
    // Si no existe la hoja USUARIOS, crearla
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_USUARIOS);
      sheet.appendRow([
        'ID',
        'Usuario',
        'Contraseña (Hash)',
        'Rol',
        'Centro',
        'Creado En',
        'Activo'
      ]);
      
      // Agregar usuario admin por defecto
      sheet.appendRow([
        'usr_admin_001',
        'admin',
        'c63bc483', // Hash correspondiente a "admin123"
        'admin',
        'Administración',
        obtenerFechaHoraPeru(),
        'TRUE'
      ]);
    }
    
    const data = sheet.getDataRange().getValues();
    const usuarios = [];

    // Convertir filas a objetos (saltar encabezado en fila 0)
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      
      // Saltar filas vacías
      if (!row[1]) continue;
      
      usuarios.push({
        id: row[0] || '',
        usuario: row[1] || '',
        contraseña: row[2] || '',
        rol: row[3] || 'usuario',
        centro: row[4] || '',
        creado_en: row[5] || '',
        activo: row[6] === 'TRUE' || row[6] === true
      });
    }
    
    console.log('✓ ' + usuarios.length + ' usuarios obtenidos');
    
    return respuestaJSON({
      success: true,
      usuarios: usuarios
    });
    
  } catch (error) {
    console.error('Error en obtenerUsuarios:', error);
    return respuestaJSON({
      success: false,
      error: error.toString()
    });
  }
}

function crearUsuario(usuario) {
  try {
    if (!usuario || !usuario.usuario) {
      return respuestaJSON({
        success: false,
        error: 'Datos de usuario incompletos'
      });
    }
    
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sheet = ss.getSheetByName(SHEET_USUARIOS);
    
    // Si no existe la hoja, crearla
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_USUARIOS);
      sheet.appendRow([
        'ID',
        'Usuario',
        'Contraseña (Hash)',
        'Rol',
        'Centro',
        'Creado En',
        'Activo'
      ]);
    }
    
    // Verificar que el usuario no exista
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][1] && data[i][1].toString().toLowerCase() === usuario.usuario.toLowerCase()) {
        return respuestaJSON({
          success: false,
          error: 'El usuario ya existe'
        });
      }
    }
    
    // Agregar nuevo usuario
    sheet.appendRow([
      usuario.id || 'usr_' + Date.now(),
      usuario.usuario || '',
      usuario.contraseña || '',
      usuario.rol || 'usuario',
      usuario.centro || '',
      usuario.creado_en || obtenerFechaHoraPeru(),
      usuario.activo !== false ? 'TRUE' : 'FALSE'
    ]);
    
    console.log('✓ Usuario creado: ' + usuario.usuario);
    
    return respuestaJSON({
      status: 'ok',
      success: true,
      message: 'Usuario creado correctamente'
    });
    
  } catch (error) {
    console.error('Error en crearUsuario:', error);
    return respuestaJSON({
      success: false,
      error: error.toString()
    });
  }
}

// ============================================================
// FUNCIONES DE RECETAS (REGISTROS)
// ============================================================

function obtenerRecetas() {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sheet = ss.getSheetByName(SHEET_RECETAS);
    
    // Si no existe RECETAS, intentar usar ENTRADAS (compatible con código antiguo)
    if (!sheet) {
      sheet = ss.getSheetByName(SHEET_ENTRADAS);
    }
    
    // Si tampoco existe ENTRADAS, crear RECETAS
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_RECETAS);
      sheet.appendRow([
        'ID',
        'COD_PRE',
        'Establecimiento',
        'Código Producto',
        'Producto',
        'Tipo Servicio',
        'Cantidad Requerida',
        'Cantidad Disponible',
        'Demanda No Satisfecha',
        'Porcentaje Cobertura',
        'Fecha Registro',
        'Observaciones',
        'Usuario Registra',
        'Fecha Registro Sistema'
      ]);
    }
    
    const data = sheet.getDataRange().getValues();
    const recetas = [];
    
    // Convertir filas a objetos (saltar encabezado)
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      
      // Saltar filas vacías
      if (!row[3] && !row[4]) continue;
      
      // Mapear correctamente para que coincida con frontend
      recetas.push({
        id: row[0] || Date.now() + Math.random(),
        cod_pre: row[1] || '',
        usuario_registra: row[12] || '',
        establecimiento: row[2] || '',
        codigo_producto: row[3] || '',
        producto: row[4] || '',
        tipo_servicio: row[5] || '',
        cantidad_requerida: parseFloat(row[6]) || 0,
        cantidad_disponible: parseFloat(row[7]) || 0,
        demanda_no_satisfecha: parseFloat(row[8]) || 0,
        cobertura: parseFloat(row[9]) || 0,
        fecha: row[10] || '',
        fecha_registro_sistema: row[13] || '',
        observaciones: row[11] || ''
      });
    }
    
    console.log('✓ ' + recetas.length + ' recetas obtenidas (sin filtrar)');
    
    return respuestaJSON({
      success: true,
      recetas: recetas
    });
    
  } catch (error) {
    console.error('Error en obtenerRecetas:', error);
    return respuestaJSON({
      success: false,
      error: error.toString()
    });
  }
}

function guardarReceta(receta) {
  try {
    if (!receta || !receta.establecimiento || !receta.producto) {
      return respuestaJSON({
        success: false,
        error: 'Datos de receta incompletos'
      });
    }
    
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sheet = ss.getSheetByName(SHEET_RECETAS);
    
    // Si no existe RECETAS, usar ENTRADAS para compatibilidad
    if (!sheet) {
      sheet = ss.getSheetByName(SHEET_ENTRADAS);
    }
    
    // Si tampoco existe, crear RECETAS
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_RECETAS);
      sheet.appendRow([
        'ID',
        'COD_PRE',
        'Establecimiento',
        'Código Producto',
        'Producto',
        'Tipo Servicio',
        'Cantidad Requerida',
        'Cantidad Disponible',
        'Demanda No Satisfecha',
        'Porcentaje Cobertura',
        'Fecha Registro',
        'Observaciones',
        'Usuario Registra',
        'Fecha Registro Sistema'
      ]);
    }
    
    // Agregar nueva receta
    sheet.appendRow([
      receta.id || Date.now() + Math.random(),
      receta.cod_pre || '',
      receta.establecimiento || '',
      receta.codigo_producto || '',
      receta.producto || '',
      receta.tipo_servicio || '',
      receta.cantidad_requerida || 0,
      receta.cantidad_disponible || 0,
      receta.demanda_no_satisfecha || 0,
      receta.porcentaje_cobertura || 0,
      receta.fecha_registro || '',
      receta.observaciones || '',
      receta.usuario_registra || '',
      receta.fecha_registro_sistema || obtenerFechaHoraPeru()
    ]);
    
    console.log('✓ Receta guardada: ' + receta.producto);
    
    return respuestaJSON({
      status: 'ok',
      success: true,
      message: 'Receta guardada correctamente'
    });
    
  } catch (error) {
    console.error('Error en guardarReceta:', error);
    return respuestaJSON({
      success: false,
      error: error.toString()
    });
  }
}

function eliminarReceta(id) {
  try {
    if (!id) {
      return respuestaJSON({
        success: false,
        error: 'ID de receta requerido'
      });
    }
    
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sheet = ss.getSheetByName(SHEET_RECETAS);
    
    if (!sheet) {
      sheet = ss.getSheetByName(SHEET_ENTRADAS);
    }
    
    if (!sheet) {
      return respuestaJSON({
        success: false,
        error: 'Hoja de recetas no encontrada'
      });
    }
    
    const data = sheet.getDataRange().getValues();
    
    // Buscar y eliminar la fila con el ID
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] == id) {
        sheet.deleteRow(i + 1); // +1 porque las filas comienzan en 1
        console.log('✓ Receta eliminada: ' + id);
        return respuestaJSON({
          success: true,
          message: 'Receta eliminada'
        });
      }
    }
    
    return respuestaJSON({
      success: false,
      error: 'Receta no encontrada'
    });
    
  } catch (error) {
    console.error('Error en eliminarReceta:', error);
    return respuestaJSON({
      success: false,
      error: error.toString()
    });
  }
}

function limpiarTodasLasRecetas() {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sheet = ss.getSheetByName(SHEET_RECETAS);
    
    if (!sheet) {
      sheet = ss.getSheetByName(SHEET_ENTRADAS);
    }
    
    if (!sheet) {
      return respuestaJSON({
        success: false,
        error: 'Hoja de recetas no encontrada'
      });
    }
    
    // Obtener datos actuales
    const data = sheet.getDataRange().getValues();
    
    // Conservar encabezado, eliminar todo lo demás
    if (data.length > 1) {
      sheet.deleteRows(2, data.length - 1);
    }
    
    console.log('✓ Todas las recetas eliminadas');
    
    return respuestaJSON({
      success: true,
      message: 'Todas las recetas han sido eliminadas'
    });
    
  } catch (error) {
    console.error('Error en limpiarTodasLasRecetas:', error);
    return respuestaJSON({
      success: false,
      error: error.toString()
    });
  }
}

// ============================================================
// FUNCIONES AUXILIARES
// ============================================================

// Filtrar recetas según rol y centro del usuario
function filtrarRecetasPorUsuario(recetas, usuarioActual) {
  // Si no se proporciona usuario o es null, devolver todas las recetas
  if (!usuarioActual) {
    console.log('⚠️ Sin información de usuario - devolviendo todas las recetas');
    return recetas;
  }
  
  const esAdmin = usuarioActual.rol === 'admin';
  const centroUsuario = usuarioActual.centro;
  
  console.log('🔍 Filtrando recetas:');
  console.log('  - Usuario: ' + usuarioActual.usuario);
  console.log('  - Rol: ' + usuarioActual.rol);
  console.log('  - Es Admin: ' + esAdmin);
  console.log('  - Centro: ' + centroUsuario);
  console.log('  - Total recetas antes de filtrar: ' + recetas.length);
  
  // Si es admin, devolver TODAS las recetas
  if (esAdmin) {
    console.log('✅ Usuario es ADMIN - devolviendo todas las ' + recetas.length + ' recetas');
    return recetas;
  }
  
  // Si NO es admin y NO tiene centro, devolver array vacío
  if (!centroUsuario) {
    console.log('⚠️ Usuario no-admin sin centro - devolviendo 0 recetas');
    return [];
  }
  
  // Si NO es admin pero SÍ tiene centro, filtrar por centro
  const centroNorm = centroUsuario.trim().toUpperCase();
  console.log('🔒 Filtrando por centro (normalizado): "' + centroNorm + '"');
  
  const recetasFiltradas = recetas.filter(r => {
    const estabNorm = (r.establecimiento || '').trim().toUpperCase();
    const coincide = estabNorm === centroNorm;
    
    if (!coincide) {
      console.log('  ❌ Excluido: "' + r.establecimiento + '" (normalizado: "' + estabNorm + '")');
    } else {
      console.log('  ✅ Incluido: "' + r.establecimiento + '"');
    }
    
    return coincide;
  });
  
  console.log('✅ Filtrado completado: ' + recetasFiltradas.length + ' de ' + recetas.length + ' recetas');
  return recetasFiltradas;
}

function respuestaJSON(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// INSTRUCCIONES DE IMPLEMENTACIÓN
// ============================================================
/*
1. Abre tu Google Apps Script (Extensiones > Apps Script)
   URL: https://script.google.com/macros/s/AKfycbyrPLiSug8sqDJawaDCHKc5M4lcj8432I63m1zIZ46J7vkzc4CiJImrNvTpSFtVH8VQ/exec

2. Reemplaza TODO el contenido de Code.gs con este código

3. Verifica que SHEET_ID coincida con tu Google Sheet:
   - Abre tu Sheet
   - Copia la ID de la URL: docs.google.com/spreadsheets/d/[AQUI_VA_LA_ID]
   - Reemplaza en línea: const SHEET_ID = '[AQUI]'

4. Guarda el archivo (Ctrl+S)

5. Crea una nueva deployación:
   - Haz clic en "Implementar" → "Nueva implementación"
   - Tipo: "App web"
   - Ejecutar como: Tu cuenta
   - Acceso: "Cualquiera"
   - Copia la URL de la nueva versión

6. Reemplaza APPS_SCRIPT_URL en script.js (línea ~5) con la nueva URL

7. Las hojas se crearán automáticamente:
   - USUARIOS: Gestiona usuarios del sistema
   - RECETAS: Almacena todos los registros

USUARIO ADMIN POR DEFECTO:
- Usuario: admin
- Contraseña: admin123

ESTRUCTURA DE HOJAS CREADAS AUTOMÁTICAMENTE:

USUARIOS:
ID | Usuario | Contraseña (Hash) | Rol | Centro | Creado En | Activo
usr_admin_001 | admin | c63bc483 | admin | Administración | 2026-01-13T... | TRUE

RECETAS:
ID | COD_PRE | Establecimiento | Código Producto | Producto | Tipo Servicio | 
Cantidad Requerida | Cantidad Disponible | Demanda No Satisfecha | 
Porcentaje Cobertura | Fecha Registro | Observaciones | Usuario Registra | 
Fecha Registro Sistema

*/
