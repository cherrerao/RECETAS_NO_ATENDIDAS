// ====================================
// CONSTANTES Y CONFIGURACIÓN
// ====================================
const STORAGE_KEY = 'recetas_no_atendidas';
const MAX_SUGERENCIAS = null;
const DEBOUNCE_DELAY = 300; // ms para búsquedas
// URL del Web App de Apps Script (para integrarlo con AppSheet/Google Sheets)
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxUwkO7SRqoiBRReI9a73nFzpZTUukmXmsrTJXukwv-VE8HtbDTW7z3QZa6acIYHqJx/exec';

// Variable global para almacenar catálogo cargado
let CATALOGO_ESTABLECIMIENTOS = {
    redes: [],
    datos_raw: []
};

// Variable global para medicamentos
let CATALOGO_MEDICAMENTOS = {
    todos: [],
    unicos: []
};

// Variable global para tipos de servicio
let CATALOGO_TIPOS_SERVICIO = [];

// Cache de elementos DOM frecuentemente usados
const DOMCache = {
    get: (id) => document.getElementById(id),
    producto: null,
    sugerenciasProductos: null,
    tipoServicio: null,
    sugerenciasTipoServicio: null,
    filtroBusqueda: null,
    cuerpoTabla: null,
    loginScreen: null,
    appContainer: null,
    // Se inicializarán en DOMContentLoaded
    init: function() {
        this.producto = this.get('producto');
        this.sugerenciasProductos = this.get('sugerenciasProductos');
        this.tipoServicio = this.get('tipo_servicio');
        this.sugerenciasTipoServicio = this.get('sugerenciasTipoServicio');
        this.filtroBusqueda = this.get('filtro_busqueda');
        this.cuerpoTabla = this.get('cuerpoTabla');
        this.loginScreen = this.get('loginScreen');
        this.appContainer = this.get('appContainer');
    }
};

// Utilidades para debounce
const debounce = (func, wait) => {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
};

// ====================================
// INICIALIZACIÓN
// ====================================
document.addEventListener('DOMContentLoaded', async () => {
    // Inicializar cache de DOM
    DOMCache.init();

    // Cargar usuarios desde Google Sheets antes de cualquier login
    try {
        await cargarUsuariosDesdeAppScript();
    } catch (e) {
        console.warn('No se pudieron cargar usuarios al inicio:', e);
    }

    // Mostrar pantalla correspondiente (pero sin detener carga de catálogos)
    if (!auth.estaAutenticado()) {
        mostrarPantallaLogin();
    } else {
        mostrarAplicacion();
    }

    // Cargar catálogos en paralelo (siempre, incluso en pantalla de login)
    Promise.all([
        cargarCatalogoDesdeExcel(),
        cargarMedicamentosDesdeJSON(),
        cargarTiposServicioDesdeExcel()
    ]).then(() => {
        inicializarAplicacion();
    }).catch(error => {
        console.error("Error al cargar catálogos:", error);
        mostrarNotificacion('Error al cargar algunos catálogos. Verifica la consola.', 'warning');
        inicializarAplicacion();
    });
});

// Inicializar aplicación después de cargar catálogos
async function inicializarAplicacion() {
    establecerFechaHoy();
    await cargarDatos(); // Ahora es async para esperar a Google Sheets
    cargarMapaCodPreGlobal(); // Cargar mapa COD PRE al inicio
    // Asegurar que los usuarios estén actualizados en memoria
    try { await cargarUsuariosDesdeAppScript(); } catch {}
    agregarEventListeners();
    agregarEventListenersAdmin();
    aplicarPermisosEstablecimientos();
    
    // Sincronizar registros pendientes si existen
    sincronizarColaPendiente();
    
    // Reintentar sincronización cada 30 segundos
    setInterval(sincronizarColaPendiente, 30000);
    
    try { 
        renderMedicamentosTable(); 
    } catch(e) { 
        console.warn('No se pudo renderizar tabla de medicamentos:', e);
    }
}

// Sincronizar registros que no se han enviado a Google Sheets
async function sincronizarColaPendiente() {
    try {
        const COLA_KEY = 'recetas_cola_sync';
        const colaGuardada = localStorage.getItem(COLA_KEY);
        
        if (!colaGuardada) return; // No hay nada que sincronizar
        
        const cola = JSON.parse(colaGuardada);
        if (cola.length === 0) return;
        
        console.log(`🔄 Sincronizando ${cola.length} registros pendientes...`);
        
        const colaPendiente = [];
        
        for (const payload of cola) {
            try {
                const resp = await fetch(APPS_SCRIPT_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                
                let result = null;
                try { result = await resp.json(); } catch {}
                const ok = (result && (result.status === 'ok' || result.result === 'ok' || result.success === true));
                
                if (ok) {
                    console.log(`✅ Sincronizado: ${payload.producto}`);
                } else {
                    console.warn(`⚠️ Respuesta no confirmada para ${payload.producto}, reintentando...`);
                    colaPendiente.push(payload);
                }
            } catch (e) {
                console.warn(`⚠️ Error sincronizando ${payload.producto}:`, e.message);
                colaPendiente.push(payload);
            }
        }
        
        if (colaPendiente.length === 0) {
            // Éxito: limpiar cola
            localStorage.removeItem(COLA_KEY);
            console.log('✅ Toda la cola ha sido sincronizada');
        } else {
            // Guardar pendientes restantes
            localStorage.setItem(COLA_KEY, JSON.stringify(colaPendiente));
            console.log(`⏳ ${colaPendiente.length} registros aún pendientes`);
        }
        
    } catch (e) {
        console.warn('Error en sincronización de cola:', e);
    }
}

// Aplicar permisos y valores por defecto para establecimientos según rol
function aplicarPermisosEstablecimientos() {
    console.log('🔐 === APLICANDO PERMISOS ===');
    try {
        // Obtener centro del usuario si existe (admin o no)
        const centroUsuario = (auth.obtenerCentroActual && auth.obtenerCentroActual()) || '';
        const esAdminFlag = auth.esAdmin && auth.esAdmin();
        console.log('✓ centroUsuario:', centroUsuario, '| esAdmin:', esAdminFlag);

        // Buscar la RED que contiene al centro del usuario
        let redNombre = '';
        if (centroUsuario && CATALOGO_ESTABLECIMIENTOS.redes && Array.isArray(CATALOGO_ESTABLECIMIENTOS.redes)) {
            for (const r of CATALOGO_ESTABLECIMIENTOS.redes) {
                if (Array.isArray(r.establecimientos) && r.establecimientos.includes(centroUsuario)) {
                    redNombre = r.nombre;
                    break;
                }
            }
        }

        // Main form: si hay centroUsuario, pre-seleccionar red y establecimiento
        const mainRed = document.getElementById('red');
        const mainEst = document.getElementById('establecimiento');
        if (mainRed && redNombre) {
            mainRed.value = redNombre;
        }
        if (mainEst && centroUsuario) {
            mainEst.value = centroUsuario;
        }

        // CONTROLES DEL FORMULARIO PRINCIPAL
        if (esAdminFlag) {
            // Admin: puede seleccionar cualquier red/establecimiento
            console.log('👨‍💼 Configurando permisos para ADMIN');
            if (mainRed) {
                mainRed.disabled = false;
                mainRed.removeAttribute('aria-disabled');
            }
            if (mainEst) {
                mainEst.disabled = false;
                mainEst.readOnly = false;
                mainEst.removeAttribute('aria-disabled');
                mainEst.removeAttribute('title');
            }
        } else {
            // Usuario de centro: solo su centro
            console.log('🏥 Configurando permisos para USUARIO DE CENTRO');
            if (!centroUsuario) return; // Sin centro asignado, no hacer nada
            
            if (mainRed) {
                mainRed.disabled = true;
                mainRed.setAttribute('aria-disabled', 'true');
            }
            if (mainEst) {
                mainEst.disabled = true;
                mainEst.readOnly = true;
                mainEst.setAttribute('aria-disabled', 'true');
                mainEst.setAttribute('title', 'Establecimiento asignado por su usuario');
            }
            
            // Ocultar el dropdown de sugerencias de establecimientos
            const sugerenciasMain = document.getElementById('sugerenciasEstablecimientosMain');
            if (sugerenciasMain) {
                sugerenciasMain.style.display = 'none';
                sugerenciasMain.classList.remove('active');
            }
            
            // Actualizar estructuras internas
            actualizarEstablecimientos();
        }

        // CONTROLES DEL MODAL DE USUARIOS (aplica a admin y usuario)
        const newRed = document.getElementById('newRed');
        const editRed = document.getElementById('editRed');
        const newCentro = document.getElementById('newCentro');
        const editCentro = document.getElementById('editCentro');
        const listaAdmin = document.getElementById('listaEstablecimientosAdmin');
        const listaEdit = document.getElementById('listaEstablecimientosEditarBox');

        if (esAdminFlag) {
            // Admin: MOSTRAR selectores de red/centro en modal
            console.log('👨‍💼 Modal: MOSTRANDO selectores de red/centro para ADMIN');
            if (newRed) {
                newRed.style.display = 'block';
                newRed.disabled = false;
            }
            if (editRed) {
                editRed.style.display = 'block';
                editRed.disabled = false;
            }
            if (newCentro) {
                newCentro.disabled = false;
            }
            if (editCentro) {
                editCentro.disabled = false;
            }
            if (listaAdmin) listaAdmin.style.display = 'block';
            if (listaEdit) listaEdit.style.display = 'block';
        } else {
            // Usuario de centro: OCULTAR selectores de red/centro, usar el suyo
            console.log('🏥 Modal: OCULTANDO selectores de red/centro para usuario');
            if (newRed) newRed.style.display = 'none';
            if (editRed) editRed.style.display = 'none';
            if (listaAdmin) listaAdmin.style.display = 'none';
            if (listaEdit) listaEdit.style.display = 'none';

            if (newCentro) {
                newCentro.value = centroUsuario;
                newCentro.disabled = true;
            }
            if (editCentro) {
                editCentro.value = centroUsuario;
                editCentro.disabled = true;
            }
        }
        
        // BOTÓN LIMPIAR DATOS
        const btnLimpiar = document.getElementById('btnLimpiar');
        console.log('🔍 btnLimpiar existe:', !!btnLimpiar, '| esAdmin:', esAdminFlag);
        if (btnLimpiar) {
            if (esAdminFlag) {
                console.log('✅ MOSTRANDO botón "Limpiar Datos" para ADMIN');
                btnLimpiar.style.display = 'inline-block';
            } else {
                console.log('❌ OCULTANDO botón "Limpiar Datos" para usuario');
                btnLimpiar.style.display = 'none';
            }
        }
    } catch (e) {
        console.warn('Error aplicando permisos de establecimientos:', e);
    }
}

// Establecer fecha actual por defecto
function establecerFechaHoy() {
    const fechaInput = document.getElementById('fecha_registro');
    const hoy = new Date().toISOString().split('T')[0];
    fechaInput.value = hoy;
}

// Cargar mapa COD PRE al inicio (desde catalogo_establecimientos.json)
async function cargarMapaCodPreGlobal() {
    try {
        const resp = await fetch('catalogo_establecimientos.json');
        if (!resp || !resp.ok) {
            console.warn('No se pudo cargar catalogo_establecimientos.json para COD PRE');
            window.mapaCodPre = {};
            return;
        }
        
        const data = await resp.json();
        const mapaCodPre = {};
        
        // Función para normalizar nombres (consistente con exportarResumenExcel)
        const normalizarNombre = (text) => {
            return (text || '')
                .toString()
                .trim()
                .toUpperCase()
                .replace(/\s+/g, ' ')      // espacios múltiples a uno
                .replace(/\./g, '')         // quitar puntos
                .replace(/\s*-\s*/g, '-');  // normalizar guiones
        };
        
        // Extraer establecimientos de todas las redes
        if (data.redes && Array.isArray(data.redes)) {
            data.redes.forEach(red => {
                if (red.establecimientos && Array.isArray(red.establecimientos)) {
                    red.establecimientos.forEach(est => {
                        if (est.nombre && est.cod_pre) {
                            const nombreNormalizado = normalizarNombre(est.nombre);
                            const cod = est.cod_pre.toString().trim();
                            mapaCodPre[nombreNormalizado] = cod;
                        }
                    });
                }
            });
        }
        
        window.mapaCodPre = mapaCodPre;
        window.mapaCodPreNorm = null;
        console.log('✓ Mapa COD PRE cargado desde JSON:', Object.keys(mapaCodPre).length, 'establecimientos');
    } catch (e) {
        console.warn('Error al cargar mapa COD PRE:', e && e.message ? e.message : e);
        window.mapaCodPre = {};
        window.mapaCodPreNorm = null;
    }
}

// Cargar catálogo desde el archivo Excel de SISMED
async function cargarCatalogoDesdeExcel() {
    try {
        // Cargar desde el archivo JSON proporcionado
        const response = await fetch('catalogo_establecimientos.json');
        if (!response.ok) {
            throw new Error('No se pudo cargar catalogo_establecimientos.json');
        }
        const data = await response.json();
        // Estructura: { redes: [ { nombre, establecimientos: [ { cod_pre, nombre } ] } ] }
        if (!data.redes || !Array.isArray(data.redes)) {
            throw new Error('Estructura de catálogo inválida');
        }
        // Adaptar a la estructura interna esperada
        CATALOGO_ESTABLECIMIENTOS.redes = data.redes.map(red => ({
            nombre: red.nombre,
            establecimientos: red.establecimientos.map(e => e.nombre)
        }));
        CATALOGO_ESTABLECIMIENTOS.datos_raw = data.redes;
        window.mapaCodPreNorm = null;
        // Mostrar cantidad en el status
        const statusEl = document.getElementById('establecimientosStatus');
        if (statusEl) {
            const total = data.redes.reduce((acc, r) => acc + r.establecimientos.length, 0);
            statusEl.textContent = `Catálogo cargado: ${total} establecimientos`;
            statusEl.style.color = '#28a745';
        }
        // Llenar datalist de establecimientos
        const datalist = document.getElementById('establecimientosLista');
        if (datalist) {
            datalist.innerHTML = '';
            data.redes.forEach(red => {
                red.establecimientos.forEach(est => {
                    // Mostrar nombre y código si existe
                    const nombre = est.nombre || est;
                    const cod = est.cod_pre ? ` (${est.cod_pre})` : '';
                    const option = document.createElement('option');
                    option.value = nombre + cod;
                    datalist.appendChild(option);
                });
            });
        }
        // Cargar selectores con datos
        cargarCatalogo();
    } catch (error) {
        console.error('❌ Error cargando catálogo de establecimientos:', error.message, error);
        cargarCatalogoPorDefecto();
    }
}

function normalizarNombreEstablecimiento(nombre) {
    if (!nombre) return '';
    let n = nombre.toString().toUpperCase();
    try {
        n = n.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    } catch (e) {}
    n = n.replace(/[^A-Z0-9\s]/g, ' ');
    n = n.replace(/\s+/g, ' ').trim();
    n = n.replace(/^(PSMC|PS|CS)\s+/, '');
    return n;
}

function obtenerCodPrePorNombre(establecimientoNombre) {
    const key = normalizarNombreEstablecimiento(establecimientoNombre);
    if (!key) return '';

    if (!window.mapaCodPreNorm) {
        const mapa = {};
        if (window.mapaCodPre && typeof window.mapaCodPre === 'object') {
            Object.keys(window.mapaCodPre).forEach(nombre => {
                const k = normalizarNombreEstablecimiento(nombre);
                if (k && !mapa[k]) mapa[k] = window.mapaCodPre[nombre];
            });
        }
        if (CATALOGO_ESTABLECIMIENTOS && Array.isArray(CATALOGO_ESTABLECIMIENTOS.datos_raw)) {
            CATALOGO_ESTABLECIMIENTOS.datos_raw.forEach(red => {
                if (red && Array.isArray(red.establecimientos)) {
                    red.establecimientos.forEach(est => {
                        const nombre = est && est.nombre ? est.nombre : '';
                        const cod = est && est.cod_pre ? est.cod_pre : '';
                        const k = normalizarNombreEstablecimiento(nombre);
                        if (k && cod && !mapa[k]) mapa[k] = cod;
                    });
                }
            });
        }
        window.mapaCodPreNorm = mapa;
    }

    return window.mapaCodPreNorm[key] || '';
}

// Catálogo por defecto en caso de error
function cargarCatalogoPorDefecto() {
    CATALOGO_ESTABLECIMIENTOS.redes = [
        {
            "nombre": "RED BELLAVISTA",
            "establecimientos": ["Centro de Salud Bellavista", "Puesto de Salud Ayacucho"]
        },
        {
            "nombre": "RED CALLAO",
            "establecimientos": ["Hospital Nacional", "Centro de Salud Callao"]
        },
        {
            "nombre": "RED VENTANILLA",
            "establecimientos": ["Centro de Salud Ventanilla", "Puesto de Salud Oquendo"]
        }
    ];
    cargarCatalogo();
}
// Cargar medicamentos desde JSON de SISMED
async function cargarMedicamentosDesdeJSON() {
    try {
        console.log("Cargando medicamentos desde medicamentos_completo.json...");
        
        // Intentar cargar desde varias rutas
        const candidates = [
            './medicamentos_completo.json',
            '../SISMED/medicamentos_completo.json',
            '../../SISMED/medicamentos_completo.json',
        ];

        let response = null;
        const intentos = [];
        
        for (const p of candidates) {
            try {
                console.log("Intentando cargar medicamentos desde:", p);
                response = await fetch(p);
                if (response.ok) {
                    console.log("✓ JSON encontrado en:", p);
                    break;
                } else {
                    intentos.push(`${p} (status ${response.status})`);
                    response = null;
                }
            } catch (err) {
                console.warn("Error intentando", p, err && err.message ? err.message : err);
                intentos.push(`${p} (error)`);
                response = null;
            }
        }

        if (!response) {
            throw new Error('No se pudo obtener el archivo JSON desde las rutas intentadas: ' + intentos.join(', '));
        }

        const medicamentosArray = await response.json();
        
        console.log("✓ medicamentos_completo.json cargado exitosamente");
        console.log("Total de medicamentos:", medicamentosArray.length);
        console.log("Primeros 5 medicamentos:", medicamentosArray.slice(0, 5));

        // Transformar a formato esperado
        const medicamentos = medicamentosArray.map(med => ({
            codigo: med.codigo || '',
            descripcion: med.nombre || '',
            categoria: 'Medicamento'
        }));

        if (medicamentos.length > 0) {
            CATALOGO_MEDICAMENTOS.unicos = medicamentos;
            CATALOGO_MEDICAMENTOS.todos = medicamentos;
            console.log("✓✓✓ Catálogo de medicamentos actualizado correctamente");
            
            // Actualizar indicador visible
            const statusEl = document.getElementById('catalogoStatus');
            if (statusEl) statusEl.textContent = `Catálogo cargado: ${medicamentos.length} medicamentos`;
            
            try { renderMedicamentosTable(); } catch(e) {}
            
            // Limpiar sugerencias previas
            const sugerenciasDiv = document.getElementById('sugerenciasProductos');
            if (sugerenciasDiv) { 
                sugerenciasDiv.innerHTML = ''; 
                sugerenciasDiv.classList.remove('active'); 
            }
        } else {
            throw new Error("No se extrajeron medicamentos del archivo");
        }
    } catch (error) {
        console.error("❌ Error cargando medicamentos:", error.message, error);
        console.error("Verifica que el archivo existe en:", "./medicamentos_completo.json o ../SISMED/medicamentos_completo.json");
        const statusEl = document.getElementById('catalogoStatus');
        if (statusEl) statusEl.textContent = 'Error cargando catálogo: ' + (error.message || 'ver consola');
    }
}

// Cargar tipos de servicio desde Excel
async function cargarTiposServicioDesdeExcel() {
    try {
        console.log("Cargando tipos de servicio desde tiposervicio.xlsx...");
        
        // Intentar cargar desde varias rutas posibles (priorizando la misma carpeta)
        const candidates = [
            './tiposervicio.xlsx',  // Primero intentar en la misma carpeta
            'tiposervicio.xlsx',
            '../Nueva carpeta/tiposervicio.xlsx',
            '../../Nueva carpeta/tiposervicio.xlsx',
            '../../../Nueva carpeta/tiposervicio.xlsx',
            '../tiposervicio.xlsx'
        ];

        let response = null;
        const intentos = [];
        
        for (const path of candidates) {
            try {
                console.log("Intentando cargar tipos de servicio desde:", path);
                response = await fetch(path);
                if (response.ok) {
                    console.log("✓ Excel de tipos de servicio encontrado en:", path);
                    break;
                } else {
                    intentos.push(`${path} (status ${response.status})`);
                    response = null;
                }
            } catch (err) {
                console.warn("Error intentando", path, err && err.message ? err.message : err);
                intentos.push(`${path} (error)`);
                response = null;
            }
        }

        if (!response || !response.ok) {
            console.warn("No se pudo cargar el archivo Excel, usando catálogo por defecto");
            cargarTiposServicioPorDefecto();
            return;
        }

        const data = await response.arrayBuffer();
        console.log("Excel de tipos de servicio cargado exitosamente, tamaño:", data.byteLength, "bytes");

        // Usar XLSX para leer el archivo
        if (typeof XLSX === 'undefined') {
            console.error('XLSX no está cargado');
            cargarTiposServicioPorDefecto();
            return;
        }

        const workbook = XLSX.read(data, { type: "array" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

        console.log("Datos cargados del Excel de tipos de servicio - Total filas:", jsonData.length);
        console.log("Primeras 10 filas del Excel:", jsonData.slice(0, 10));

        // Buscar encabezados (opcional) - más flexible
        let headerIndex = -1;
        let tipoServicioIndex = 0; // Por defecto usar primera columna
        
        // Primero, buscar si hay encabezados
        for (let i = 0; i < Math.min(jsonData.length, 10); i++) {
            const row = jsonData[i];
            if (Array.isArray(row) && row.length > 0) {
                const rowStr = row.map(c => c?.toString().toUpperCase().trim() || '').join('|');
                // Buscar si es encabezado
                if (rowStr.includes('TIPO') || rowStr.includes('SERVICIO') || rowStr.includes('DESCRIPCION') || 
                    rowStr.includes('NOMBRE') || rowStr.includes('NOMUPS') || rowStr.includes('FARMACOTECNIA')) {
                    headerIndex = i;
                    console.log("✓ Header encontrado en fila:", i);
                    console.log("Contenido del header:", row);
                    
                    // Buscar índice de columna en el encabezado
                    const headers = row.map(h => h?.toString().trim() || "");
                    for (let j = 0; j < headers.length; j++) {
                        const headerUpper = headers[j].toUpperCase();
                        if (headerUpper.includes('TIPO') || headerUpper.includes('SERVICIO') || 
                            headerUpper.includes('DESCRIPCION') || headerUpper.includes('NOMBRE') ||
                            headerUpper.includes('NOMUPS') || headerUpper.includes('FARMACOTECNIA')) {
                            tipoServicioIndex = j;
                            console.log("✓ Tipo de servicio encontrado en columna:", j, "-", headers[j]);
                            break;
                        }
                    }
                    break;
                }
            }
        }

        // Si no hay encabezados, usar todas las filas desde el inicio
        // Determinar desde dónde empezar a leer datos
        const startRow = headerIndex >= 0 ? headerIndex + 1 : 0;
        const rows = jsonData.slice(startRow);
        console.log("Total de filas de datos:", rows.length);
        console.log("Usando columna índice:", tipoServicioIndex);
        console.log("Primeras 5 filas de datos:", rows.slice(0, 5));

        // Extraer tipos de servicio únicos de todas las filas
        const tiposSet = new Set();
        rows.forEach((row, idx) => {
            if (Array.isArray(row) && row.length > tipoServicioIndex) {
                // Intentar todas las columnas si la primera está vacía
                let tipo = null;
                if (row[tipoServicioIndex]) {
                    tipo = row[tipoServicioIndex]?.toString().trim();
                } else {
                    // Buscar en otras columnas
                    for (let col = 0; col < row.length; col++) {
                        const valor = row[col]?.toString().trim();
                        if (valor && valor !== '') {
                            tipo = valor;
                            break;
                        }
                    }
                }
                
                if (tipo && tipo !== '' && 
                    tipo.toUpperCase() !== 'TIPO' && 
                    tipo.toUpperCase() !== 'SERVICIO' &&
                    !tipo.toUpperCase().includes('DESCRIPCION') &&
                    !tipo.toUpperCase().includes('NOMBRE')) {
                    tiposSet.add(tipo);
                }
            }
        });

        CATALOGO_TIPOS_SERVICIO = Array.from(tiposSet).sort();
        console.log("✓✓✓ Tipos de servicio cargados exitosamente:", CATALOGO_TIPOS_SERVICIO.length);
        console.log("=== LISTA COMPLETA DE TIPOS DE SERVICIO ===");
        CATALOGO_TIPOS_SERVICIO.forEach((tipo, idx) => {
            console.log(`${idx + 1}. ${tipo}`);
        });
        console.log("===========================================");

        // Actualizar indicador visible
        const statusEl = document.getElementById('tiposServicioStatus');
        if (statusEl) {
            statusEl.textContent = `Catálogo cargado: ${CATALOGO_TIPOS_SERVICIO.length} tipos de servicio`;
            statusEl.style.color = '#28a745';
        }
        
        // Verificar que el campo esté disponible y mostrar mensaje
        if (DOMCache.tipoServicio) {
            console.log('Campo tipo_servicio encontrado y listo');
        } else {
            console.warn('Campo tipo_servicio no encontrado en DOMCache');
        }

    } catch (error) {
        console.error("❌ Error cargando tipos de servicio:", error.message, error);
        cargarTiposServicioPorDefecto();
    }
}

// Catálogo por defecto de tipos de servicio
function cargarTiposServicioPorDefecto() {
    CATALOGO_TIPOS_SERVICIO = [
        'Consulta Externa',
        'Emergencia',
        'Hospitalización',
        'Cirugía',
        'Laboratorio',
        'Rayos X',
        'Farmacia',
        'Odontología',
        'Ginecología',
        'Pediatría',
        'Medicina General',
        'Cardiología',
        'Dermatología',
        'Neurología',
        'Oftalmología'
    ];
    console.log("✓ Tipos de servicio por defecto cargados:", CATALOGO_TIPOS_SERVICIO.length);
    console.log("Tipos por defecto:", CATALOGO_TIPOS_SERVICIO);
    
    const statusEl = document.getElementById('tiposServicioStatus');
    if (statusEl) {
        statusEl.textContent = `Catálogo por defecto: ${CATALOGO_TIPOS_SERVICIO.length} tipos de servicio`;
        statusEl.style.color = '#ffc107';
    }
}

// Extraer medicamentos desde un workbook de XLSX
function extraerMedicamentosDesdeWorkbook(workbook) {
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    // Buscar encabezados - CODIGO y DESCRIPCION
    let headerIndex = -1;
    for (let i = 0; i < Math.min(jsonData.length, 20); i++) {
        const row = jsonData[i];
        if (Array.isArray(row) && row.length > 0) {
            const rowStr = row.map(c => c?.toString().toUpperCase().trim() || '').join('|');
            if (rowStr.includes('CODIGO') || rowStr.includes('DESCRIPCION') || rowStr.includes('MEDICAMENTO')) {
                headerIndex = i;
                break;
            }
        }
    }

    if (headerIndex === -1) {
        throw new Error('No se encontraron encabezados en el archivo Excel');
    }

    const headers = jsonData[headerIndex].map(h => h?.toString().trim() || "");

    // Encontrar índices de CODIGO y DESCRIPCION
    let codIndex = -1;
    let descIndex = -1;
    for (let i = 0; i < headers.length; i++) {
        const headerUpper = headers[i].toUpperCase();
        if (headerUpper.includes('CODIGO') || headerUpper.includes('COD')) codIndex = i;
        if (headerUpper.includes('DESCRIPCION') || headerUpper.includes('DESC') || headerUpper.includes('MEDICAMENTO')) descIndex = i;
    }

    if (codIndex === -1 || descIndex === -1) {
        throw new Error('No se pudieron identificar las columnas CODIGO/DESCRIPCION');
    }

    const rows = jsonData.slice(headerIndex + 1);
    const medicamentos = [];
    rows.forEach(row => {
        if (!Array.isArray(row)) return;
        const codigo = row[codIndex]?.toString().trim();
        const descripcion = row[descIndex]?.toString().trim();
        if (codigo && descripcion) {
            medicamentos.push({ codigo, descripcion, categoria: 'Medicamento' });
        }
    });

    return medicamentos;
}

// Renderizar tabla de medicamentos en la sección de catálogo (optimizado)
function renderMedicamentosTable() {
    const tbody = DOMCache.get('medicamentos-tbody');
    const input = DOMCache.get('search-medicamentos');
    
    if (!tbody) return;
    
    const lista = (CATALOGO_MEDICAMENTOS.unicos && CATALOGO_MEDICAMENTOS.unicos.length > 0) 
        ? CATALOGO_MEDICAMENTOS.unicos 
        : [];
    
    if (lista.length === 0) {
        tbody.innerHTML = '<tr class="empty-state"><td colspan="3">Catálogo cargándose... Si persiste, verifica la consola.</td></tr>';
        return;
    }

    // Usar DocumentFragment para mejor rendimiento
    const fragment = document.createDocumentFragment();
    
    lista.forEach(item => {
        const tr = document.createElement('tr');
        const tdCod = document.createElement('td');
        const tdDesc = document.createElement('td');
        const tdCat = document.createElement('td');
        
        tdCod.textContent = item.codigo || '';
        tdDesc.textContent = item.descripcion || '';
        tdCat.textContent = item.categoria || 'Medicamento';
        
        tr.appendChild(tdCod);
        tr.appendChild(tdDesc);
        tr.appendChild(tdCat);
        fragment.appendChild(tr);
    });
    
    tbody.innerHTML = '';
    tbody.appendChild(fragment);

    if (input) input.value = '';
}

// Filtrar tabla de medicamentos (con debounce)
const filtrarMedicamentosTableDebounced = debounce(() => {
    const input = DOMCache.get('search-medicamentos');
    const tbody = DOMCache.get('medicamentos-tbody');
    
    if (!tbody) return;
    
    const filter = input ? input.value.toLowerCase().trim() : '';
    const rows = Array.from(tbody.getElementsByTagName('tr'));
    
    rows.forEach(row => {
        // Saltar fila de estado vacío
        if (row.classList.contains('empty-state')) {
            row.style.display = filter ? 'none' : '';
            return;
        }
        
        const cells = Array.from(row.getElementsByTagName('td'));
        if (cells.length === 0) {
            row.style.display = 'none';
            return;
        }
        
        const text = cells.map(c => c.textContent.toLowerCase()).join(' ');
        row.style.display = text.includes(filter) ? '' : 'none';
    });
}, DEBOUNCE_DELAY);

// Función wrapper para mantener compatibilidad
function filtrarMedicamentosTable() {
    filtrarMedicamentosTableDebounced();
}

// Función anterior eliminada - ya no usamos JSON local

// Cargar catálogo de establecimientos en los selectores
function cargarCatalogo() {
    const selectRed = document.getElementById('red');
    
    console.log("cargarCatalogo() - Redes disponibles:", CATALOGO_ESTABLECIMIENTOS.redes.length);
    
    if (!selectRed) {
        console.error("No se encontró el elemento #red");
        return;
    }
    
    // Limpiar opciones previas (excepto la primera)
    while (selectRed.options.length > 1) {
        selectRed.remove(1);
    }
    
    // Llenar opciones de redes
    if (CATALOGO_ESTABLECIMIENTOS.redes.length === 0) {
        console.warn("No hay redes para cargar");
        return;
    }
    
    CATALOGO_ESTABLECIMIENTOS.redes.forEach(red => {
        const option = document.createElement('option');
        option.value = red.nombre;
        option.textContent = red.nombre;
        selectRed.appendChild(option);
        const total = Array.isArray(red.establecimientos) ? red.establecimientos.length : 0;
        console.log("Red agregada:", red.nombre, "con", total, "establecimientos");
    });
    
    console.log("Total de opciones en select:", selectRed.options.length);

    // Actualizar estado visible con total de establecimientos
    const totalEstablecimientos = CATALOGO_ESTABLECIMIENTOS.redes.reduce((sum, r) => sum + (Array.isArray(r.establecimientos) ? r.establecimientos.length : 0), 0);
    window.ESTABLECIMIENTOS_TOTAL = totalEstablecimientos;
    const statusEl = document.getElementById('establecimientosStatus');
    if (statusEl) {
        statusEl.textContent = `Catálogo cargado: ${totalEstablecimientos} establecimientos`;
        statusEl.style.color = '#28a745';
    }

    // También poblar selects de admin (crear/editar usuario) si existen
    const newRed = document.getElementById('newRed');
    const editRed = document.getElementById('editRed');
    if (newRed) {
        // limpiar
        while (newRed.options.length > 1) newRed.remove(1);
        CATALOGO_ESTABLECIMIENTOS.redes.forEach(red => {
            const opt = document.createElement('option');
            opt.value = red.nombre;
            opt.textContent = red.nombre;
            newRed.appendChild(opt);
        });
        newRed.addEventListener('change', () => actualizarEstablecimientosAdmin('new'));
    }
    if (editRed) {
        while (editRed.options.length > 1) editRed.remove(1);
        CATALOGO_ESTABLECIMIENTOS.redes.forEach(red => {
            const opt = document.createElement('option');
            opt.value = red.nombre;
            opt.textContent = red.nombre;
            editRed.appendChild(opt);
        });
        editRed.addEventListener('change', () => actualizarEstablecimientosAdmin('edit'));
    }

    // Lista principal permanece oculta por defecto; se renderiza solo para admin bajo demanda
}

// Filtrar y mostrar sugerencias de productos (con debounce)
const filtrarProductosDebounced = debounce(() => {
    const inputProducto = DOMCache.producto;
    const sugerenciasDiv = DOMCache.sugerenciasProductos;
    
    if (!inputProducto || !sugerenciasDiv) return;
    
    const busqueda = inputProducto.value.toLowerCase().trim();

    if (busqueda.length < 1) {
        sugerenciasDiv.innerHTML = '';
        sugerenciasDiv.classList.remove('active');
        return;
    }

    // Filtrar medicamentos que coincidan con la búsqueda
    const resultados = CATALOGO_MEDICAMENTOS.unicos
        .filter(med => {
            const codigo = (med.codigo || '').toLowerCase();
            const descripcion = (med.descripcion || '').toLowerCase();
            const categoria = (med.categoria || '').toLowerCase();
            
            return codigo.includes(busqueda) || 
                   descripcion.includes(busqueda) || 
                   categoria.includes(busqueda);
        })
        .sort((a, b) => {
            const codigoA = (a.codigo || '').toLowerCase();
            const descA = (a.descripcion || '').toLowerCase();
            const codigoB = (b.codigo || '').toLowerCase();
            const descB = (b.descripcion || '').toLowerCase();

            const startsA = descA.startsWith(busqueda) || codigoA.startsWith(busqueda);
            const startsB = descB.startsWith(busqueda) || codigoB.startsWith(busqueda);
            if (startsA !== startsB) return startsB - startsA;

            const idxA = Math.min(
                descA.includes(busqueda) ? descA.indexOf(busqueda) : Number.MAX_SAFE_INTEGER,
                codigoA.includes(busqueda) ? codigoA.indexOf(busqueda) : Number.MAX_SAFE_INTEGER
            );
            const idxB = Math.min(
                descB.includes(busqueda) ? descB.indexOf(busqueda) : Number.MAX_SAFE_INTEGER,
                codigoB.includes(busqueda) ? codigoB.indexOf(busqueda) : Number.MAX_SAFE_INTEGER
            );
            if (idxA !== idxB) return idxA - idxB;

            if (descA.length !== descB.length) return descA.length - descB.length;

            return descA.localeCompare(descB) || codigoA.localeCompare(codigoB);
        });

    const resultadosFinales = (MAX_SUGERENCIAS && resultados.length > MAX_SUGERENCIAS)
        ? resultados.slice(0, MAX_SUGERENCIAS)
        : resultados;

    if (resultadosFinales.length === 0) {
        sugerenciasDiv.innerHTML = '<div class="sugerencia-item" style="color: #999;">No se encontraron medicamentos</div>';
        sugerenciasDiv.classList.add('active');
        return;
    }

    // Escapar HTML para prevenir XSS
    const escaparHTML = (text) => {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    };

    sugerenciasDiv.innerHTML = resultadosFinales.map(med => {
        const codigoEscapado = escaparHTML(med.codigo || '');
        const descripcionEscapada = escaparHTML(med.descripcion || '');
        const categoriaEscapada = escaparHTML(med.categoria || '');
        
        return `
            <div class="sugerencia-item" onclick="seleccionarProducto('${codigoEscapado.replace(/'/g, "\\'")}', '${descripcionEscapada.replace(/'/g, "\\'")}')">
                <div class="sugerencia-codigo">[${codigoEscapado}]</div>
                <div class="sugerencia-descripcion">${descripcionEscapada}</div>
                <div class="sugerencia-categoria" style="font-size: 0.85em; color: #999; margin-top: 2px;">${categoriaEscapada}</div>
            </div>
        `;
    }).join('');

    sugerenciasDiv.classList.add('active');
}, DEBOUNCE_DELAY);

// Función wrapper para mantener compatibilidad
function filtrarProductos() {
    filtrarProductosDebounced();
}

// Seleccionar un producto de las sugerencias
function seleccionarProducto(codigo, descripcion) {
    // Mostrar ambos: código y descripción
    if (DOMCache.producto) {
        DOMCache.producto.value = `[${codigo}] ${descripcion}`;
    }
    if (DOMCache.sugerenciasProductos) {
        DOMCache.sugerenciasProductos.classList.remove('active');
        DOMCache.sugerenciasProductos.innerHTML = '';
    }
}

// Filtrar y mostrar sugerencias de tipos de servicio (con debounce)
const filtrarTiposServicioDebounced = debounce(() => {
    const inputTipoServicio = DOMCache.tipoServicio;
    const sugerenciasDiv = DOMCache.sugerenciasTipoServicio;
    
    if (!inputTipoServicio || !sugerenciasDiv) return;
    
    const busqueda = inputTipoServicio.value.toLowerCase().trim();

    // Si está vacío, mostrar todos los tipos
    if (busqueda.length < 1) {
        if (CATALOGO_TIPOS_SERVICIO.length > 0) {
            mostrarTodosTiposServicio();
        } else {
            sugerenciasDiv.innerHTML = '';
            sugerenciasDiv.classList.remove('active');
        }
        return;
    }

    // Filtrar tipos de servicio que coincidan con la búsqueda (sin límite)
    const resultados = CATALOGO_TIPOS_SERVICIO.filter(tipo => 
        tipo.toLowerCase().includes(busqueda)
    );

    if (resultados.length === 0) {
        sugerenciasDiv.innerHTML = '<div class="sugerencia-item" style="color: #999;">No se encontraron tipos de servicio</div>';
        sugerenciasDiv.classList.add('active');
        return;
    }

    // Escapar HTML para prevenir XSS
    const escaparHTML = (text) => {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    };

    sugerenciasDiv.innerHTML = resultados.map(tipo => {
        const tipoEscapado = escaparHTML(tipo);
        return `
            <div class="sugerencia-item" onclick="seleccionarTipoServicio('${tipoEscapado.replace(/'/g, "\\'")}')">
                <div class="sugerencia-descripcion">🏥 ${tipoEscapado}</div>
            </div>
        `;
    }).join('');

    sugerenciasDiv.classList.add('active');
}, DEBOUNCE_DELAY);

// Función wrapper para mantener compatibilidad
function filtrarTiposServicio() {
    filtrarTiposServicioDebounced();
}

// Seleccionar un tipo de servicio de las sugerencias
function seleccionarTipoServicio(tipoServicio) {
    if (DOMCache.tipoServicio) {
        DOMCache.tipoServicio.value = tipoServicio;
    }
    if (DOMCache.sugerenciasTipoServicio) {
        DOMCache.sugerenciasTipoServicio.classList.remove('active');
        DOMCache.sugerenciasTipoServicio.innerHTML = '';
    }
}

// Mostrar todos los tipos de servicio cuando se enfoca el campo
function mostrarTodosTiposServicio() {
    const inputTipoServicio = DOMCache.tipoServicio;
    const sugerenciasDiv = DOMCache.sugerenciasTipoServicio;
    
    if (!inputTipoServicio || !sugerenciasDiv) {
        console.warn('Elementos de tipo de servicio no encontrados');
        return;
    }
    
    if (CATALOGO_TIPOS_SERVICIO.length === 0) {
        console.warn('Catálogo de tipos de servicio vacío');
        sugerenciasDiv.innerHTML = '<div class="sugerencia-item" style="color: #999;">Catálogo vacío. Cargando...</div>';
        sugerenciasDiv.classList.add('active');
        return;
    }
    
    // Mostrar TODOS los tipos sin límite
    const resultados = CATALOGO_TIPOS_SERVICIO;
    console.log('📋 Mostrando TODOS los', resultados.length, 'tipos de servicio del Excel');
    
    const escaparHTML = (text) => {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    };
    
    // Crear lista con scroll si hay muchos elementos
    const maxHeight = resultados.length > 10 ? '400px' : 'auto';
    
    sugerenciasDiv.style.maxHeight = maxHeight;
    sugerenciasDiv.style.overflowY = resultados.length > 10 ? 'auto' : 'visible';
    
    sugerenciasDiv.innerHTML = resultados.map((tipo, index) => {
        const tipoEscapado = escaparHTML(tipo);
        return `
            <div class="sugerencia-item" onclick="seleccionarTipoServicio('${tipoEscapado.replace(/'/g, "\\'")}')" style="cursor: pointer;">
                <div class="sugerencia-descripcion">🏥 ${tipoEscapado}</div>
            </div>
        `;
    }).join('');
    
    sugerenciasDiv.classList.add('active');
    console.log('✓ Lista completa de tipos de servicio mostrada');
}

// Actualizar establecimientos según red seleccionada
function actualizarEstablecimientos() {
    const redSeleccionada = document.getElementById('red').value;
    // Soportar tanto <select> como <input> en el DOM para el campo establecimiento
    const elEst = document.getElementById('establecimiento');
    const sugerenciasMain = document.getElementById('sugerenciasEstablecimientosMain');

    // Si no hay elemento, salir
    if (!elEst) return;

    // Obtener la red si existe
    const red = CATALOGO_ESTABLECIMIENTOS.redes.find(r => r.nombre === redSeleccionada);

    // Guardar lista actual de establecimientos por red para uso en autocompletado
    if (red && Array.isArray(red.establecimientos)) {
        window.ESTABLECIMIENTOS_POR_RED = red.establecimientos.slice();
    } else {
        window.ESTABLECIMIENTOS_POR_RED = [];
    }

    // Si el campo es un <select>, poblar opciones (compatibilidad retro)
    if (elEst.tagName.toLowerCase() === 'select') {
        const selectEstablecimiento = elEst;
        // Limpiar opciones previas
        while (selectEstablecimiento.options.length > 0) selectEstablecimiento.remove(0);
        if (!redSeleccionada) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = '-- Primero selecciona una RED --';
            selectEstablecimiento.appendChild(opt);
            selectEstablecimiento.disabled = true;
            return;
        }
        selectEstablecimiento.disabled = false;
        window.ESTABLECIMIENTOS_POR_RED.forEach(establecimiento => {
            const option = document.createElement('option');
            option.value = establecimiento;
            option.textContent = establecimiento;
            selectEstablecimiento.appendChild(option);
        });
        // Mostrar lista visible para la red seleccionada
        try { renderListaEstablecimientos(redSeleccionada, 'listaEstablecimientosMain'); } catch (e) {}
        return;
    }

    // Si es input (nuevo comportamiento): activar el campo y mostrar placeholder
    if (elEst.tagName.toLowerCase() === 'input') {
        // Si no hay red seleccionada, deshabilitar entrada
        if (!redSeleccionada) {
            elEst.value = '';
            elEst.disabled = true;
            elEst.placeholder = 'Selecciona primero una RED';
            if (sugerenciasMain) {
                sugerenciasMain.innerHTML = '<div class="sugerencia-item" style="color:#999;">Primero selecciona una RED</div>';
                sugerenciasMain.classList.remove('active');
            }
        } else {
            elEst.disabled = false;
            elEst.placeholder = 'Escribe para buscar dentro de la red seleccionada';
            if (sugerenciasMain) {
                sugerenciasMain.innerHTML = '';
                sugerenciasMain.classList.remove('active');
            }
        }
        // Actualizar estado con conteo por red
        const statusEl = document.getElementById('establecimientosStatus');
        if (statusEl) {
            const totalPorRed = (window.ESTABLECIMIENTOS_POR_RED && window.ESTABLECIMIENTOS_POR_RED.length) || 0;
            if (redSeleccionada) {
                statusEl.textContent = `${redSeleccionada}: ${totalPorRed} establecimientos (total: ${window.ESTABLECIMIENTOS_TOTAL || 0})`;
            } else {
                statusEl.textContent = `Catálogo cargado: ${window.ESTABLECIMIENTOS_TOTAL || 0} establecimientos`;
            }
        }
        // Mostrar lista visible actualizada para la red o vacía
        try { renderListaEstablecimientos(redSeleccionada || null, 'listaEstablecimientosMain'); } catch (e) {}
    }
}

// Filtrar y mostrar sugerencias para el campo establecimiento principal
function filtrarEstablecimientosMain() {
    // Si no es admin, no mostrar sugerencias
    if (!auth.esAdmin()) {
        return;
    }
    
    const input = document.getElementById('establecimiento');
    const sugerenciasDiv = document.getElementById('sugerenciasEstablecimientosMain');

    if (!input || !sugerenciasDiv) return;

    const busqueda = input.value.toLowerCase().trim();

    // Si no hay red seleccionada, ofrecer todos los establecimientos del catálogo
    let lista = [];
    if (window.ESTABLECIMIENTOS_POR_RED && window.ESTABLECIMIENTOS_POR_RED.length > 0) {
        lista = window.ESTABLECIMIENTOS_POR_RED;
    } else {
        lista = obtenerTodosLosEstablecimientos();
    }

    if (busqueda.length < 1) {
        sugerenciasDiv.innerHTML = '';
        sugerenciasDiv.classList.remove('active');
        return;
    }

    const resultados = lista.filter(e => e.toLowerCase().includes(busqueda)).slice(0, 20);
    if (resultados.length === 0) {
        sugerenciasDiv.innerHTML = '<div class="sugerencia-item" style="color: #999;">No se encontraron establecimientos</div>';
        sugerenciasDiv.classList.add('active');
        return;
    }

    sugerenciasDiv.innerHTML = resultados.map(est => `
        <div class="sugerencia-item" onclick="seleccionarEstablecimientoMain('${est.replace(/'/g, "\\'")}')">
            <div class="sugerencia-descripcion">🏥 ${est}</div>
        </div>
    `).join('');
    sugerenciasDiv.classList.add('active');
}

function mostrarTodosEstablecimientosMain() {
    // Si no es admin, no mostrar sugerencias
    if (!auth.esAdmin()) {
        return;
    }
    
    const input = document.getElementById('establecimiento');
    const sugerenciasDiv = document.getElementById('sugerenciasEstablecimientosMain');
    if (!input || !sugerenciasDiv) return;

    let lista = [];
    if (window.ESTABLECIMIENTOS_POR_RED && window.ESTABLECIMIENTOS_POR_RED.length > 0) {
        lista = window.ESTABLECIMIENTOS_POR_RED;
    } else {
        lista = obtenerTodosLosEstablecimientos();
    }

    sugerenciasDiv.innerHTML = lista.slice(0, 50).map(est => `
        <div class="sugerencia-item" onclick="seleccionarEstablecimientoMain('${est.replace(/'/g, "\\'")}')">
            <div class="sugerencia-descripcion">🏥 ${est}</div>
        </div>
    `).join('');
    sugerenciasDiv.classList.add('active');
}

function seleccionarEstablecimientoMain(establecimiento) {
    const input = document.getElementById('establecimiento');
    const sugerenciasDiv = document.getElementById('sugerenciasEstablecimientosMain');
    const redSeleccionada = document.getElementById('red')?.value || '';
    if (!redSeleccionada) {
        mostrarNotificacion('Debes seleccionar primero una RED', 'warning');
        return;
    }
    if (input) input.value = establecimiento;
    if (sugerenciasDiv) {
        sugerenciasDiv.classList.remove('active');
        sugerenciasDiv.innerHTML = '';
    }
}

// Agregar event listeners (optimizado)
function agregarEventListeners() {
    const formRegistro = DOMCache.get('formRegistro');
    const btnLimpiar = DOMCache.get('btnLimpiar');
    const btnExportar = DOMCache.get('btnExportar');
    const btnDescargarResumenExcel = DOMCache.get('btnDescargarResumenExcel');
    const filtroBusqueda = DOMCache.filtroBusqueda;
    const cantidadRequerida = DOMCache.get('cantidad_requerida');
    const cantidadDisponible = DOMCache.get('cantidad_disponible');
    const btnResetForm = document.getElementById('btnResetForm');
    
    if (btnResetForm) { btnResetForm.addEventListener('click', limpiarFormulario); }
    
    if (formRegistro) {
        formRegistro.addEventListener('submit', agregarRegistro);
    }
    
    if (btnLimpiar) {
        btnLimpiar.addEventListener('click', limpiarDatos);
    }
    
    if (btnExportar) {
        btnExportar.addEventListener('click', exportarCSV);
    }
    
    if (btnDescargarResumenExcel) {
        btnDescargarResumenExcel.addEventListener('click', exportarResumenExcel);
    }
    
    if (filtroBusqueda) {
        filtroBusqueda.addEventListener('input', filtrarTabla);
    }
    
    // Calcular demanda no satisfecha en tiempo real
    if (cantidadRequerida) {
        cantidadRequerida.addEventListener('input', calcularDemanda);
    }
    
    if (cantidadDisponible) {
        cantidadDisponible.addEventListener('input', calcularDemanda);
    }
    
    // Cerrar sugerencias al hacer click fuera (usando delegación de eventos)
    document.addEventListener('click', function(event) {
        const sugerenciasDiv = DOMCache.sugerenciasProductos;
        const inputProducto = DOMCache.producto;
        
        if (sugerenciasDiv && inputProducto && 
            !event.target.closest('.autocomplete-wrapper') &&
            !event.target.closest('.sugerencias-list')) {
            sugerenciasDiv.classList.remove('active');
        }
    });
    
    // Autocomplete para ESTABLECIMIENTO en formulario principal
    const establecimientoInput = document.getElementById('establecimiento');
    const sugerenciasMain = document.getElementById('sugerenciasEstablecimientosMain');
    if (establecimientoInput) {
        establecimientoInput.addEventListener('keyup', filtrarEstablecimientosMain);
        establecimientoInput.addEventListener('focus', mostrarTodosEstablecimientosMain);
    }
    // Cerrar sugerencias de establecimiento si se hace click fuera
    document.addEventListener('click', function(event) {
        if (sugerenciasMain && establecimientoInput && !event.target.closest('#establecimiento') && !event.target.closest('#sugerenciasEstablecimientosMain')) {
            sugerenciasMain.classList.remove('active');
        }
    });
    
    // Actualizar selects según permisos
    actualizarSelectosSegunPermiso();
}

// Calcular demanda no satisfecha
function calcularDemanda() {
    const requerida = parseFloat(document.getElementById('cantidad_requerida').value) || 0;
    const disponible = parseFloat(document.getElementById('cantidad_disponible').value) || 0;
    const demandaNoSatisfecha = Math.max(0, requerida - disponible);
    
    // Mostrar información adicional si es necesario
    if (demandaNoSatisfecha > 0) {
        const cobertura = ((disponible / requerida) * 100).toFixed(2);
        console.log(`Demanda no satisfecha: ${demandaNoSatisfecha} (Cobertura: ${cobertura}%)`);
    }
}

async function limpiarFormulario() {
const form = document.getElementById('formRegistro');
if (!form) return;
form.reset(); // resetea inputs
// volver a establecer fecha hoy (porque el input fecha es readonly)
establecerFechaHoy();
// limpiar sugerencias / datalists si aplica
if (DOMCache.sugerenciasProductos) { DOMCache.sugerenciasProductos.innerHTML = ''; DOMCache.sugerenciasProductos.classList.remove('active'); }
if (DOMCache.sugerenciasTipoServicio) { DOMCache.sugerenciasTipoServicio.innerHTML = ''; DOMCache.sugerenciasTipoServicio.classList.remove('active'); }
const sugerenciasMain = document.getElementById('sugerenciasEstablecimientosMain');
if (sugerenciasMain) { sugerenciasMain.innerHTML = ''; sugerenciasMain.classList.remove('active'); }
mostrarNotificacion && mostrarNotificacion('Campos del formulario limpiados', 'info');
}

function normalizarTextoCatalogo(valor) {
    if (valor === null || valor === undefined) return '';
    let texto = valor.toString().trim().toUpperCase();
    try {
        texto = texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    } catch (e) {}
    return texto.replace(/\s+/g, ' ').trim();
}

function codigosCoinciden(codigoA, codigoB) {
    const a = (codigoA || '').toString().trim();
    const b = (codigoB || '').toString().trim();
    if (!a || !b) return false;

    if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
        return parseInt(a, 10) === parseInt(b, 10);
    }

    return normalizarTextoCatalogo(a) === normalizarTextoCatalogo(b);
}

function esProductoCatalogoValido(productoIngresado) {
    const valor = (productoIngresado || '').toString().trim();
    const catalogo = Array.isArray(CATALOGO_MEDICAMENTOS.unicos) ? CATALOGO_MEDICAMENTOS.unicos : [];

    if (!valor || catalogo.length === 0) return false;

    const formatoConCodigo = valor.match(/^\[(.+?)\]\s*(.+)$/);
    if (formatoConCodigo) {
        const codigoInput = formatoConCodigo[1].trim();
        const descripcionInput = formatoConCodigo[2].trim();
        return catalogo.some(med => {
            const codigoMed = (med.codigo || '').toString().trim();
            const descripcionMed = (med.descripcion || '').toString().trim();
            return codigosCoinciden(codigoInput, codigoMed) &&
                normalizarTextoCatalogo(descripcionInput) === normalizarTextoCatalogo(descripcionMed);
        });
    }

    const valorNormalizado = normalizarTextoCatalogo(valor);
    return catalogo.some(med => {
        const codigoMed = (med.codigo || '').toString().trim();
        const descripcionMed = (med.descripcion || '').toString().trim();
        return valorNormalizado === normalizarTextoCatalogo(descripcionMed) ||
            valorNormalizado === normalizarTextoCatalogo(codigoMed);
    });
}

function esTipoServicioCatalogoValido(tipoServicioIngresado) {
    const valorNormalizado = normalizarTextoCatalogo(tipoServicioIngresado);
    if (!valorNormalizado || !Array.isArray(CATALOGO_TIPOS_SERVICIO) || CATALOGO_TIPOS_SERVICIO.length === 0) {
        return false;
    }

    return CATALOGO_TIPOS_SERVICIO.some(tipo => normalizarTextoCatalogo(tipo) === valorNormalizado);
}

// Validar formulario de registro
function validarFormularioRegistro() {
    const establecimiento = DOMCache.get('establecimiento')?.value.trim();
    const producto = DOMCache.producto?.value.trim();
    const tipoServicio = DOMCache.tipoServicio?.value.trim();
    const cantidadRequerida = parseFloat(DOMCache.get('cantidad_requerida')?.value || 0);
    const cantidadDisponible = parseFloat(DOMCache.get('cantidad_disponible')?.value || 0);
    const fecha = DOMCache.get('fecha_registro')?.value;

    const errores = [];

    if (!establecimiento) {
        errores.push('Debes seleccionar un establecimiento');
    }

    if (!producto || producto.length < 3) {
        errores.push('Debes ingresar un producto válido');
    } else if (!esProductoCatalogoValido(producto)) {
        errores.push('Debes seleccionar un producto existente del catálogo');
    }

    if (!tipoServicio || tipoServicio.length < 2) {
        errores.push('Debes ingresar o seleccionar un tipo de servicio');
    } else if (!esTipoServicioCatalogoValido(tipoServicio)) {
        errores.push('Debes seleccionar un tipo de servicio existente del catálogo');
    }

    if (isNaN(cantidadRequerida) || cantidadRequerida < 0) {
        errores.push('La cantidad requerida debe ser un número válido mayor o igual a 0');
    }

    if (isNaN(cantidadDisponible) || cantidadDisponible < 0) {
        errores.push('La cantidad disponible debe ser un número válido mayor o igual a 0');
    }

    if (cantidadDisponible > cantidadRequerida) {
        errores.push('La cantidad disponible no puede ser mayor que la requerida');
    }

    if (!fecha) {
        errores.push('Debes seleccionar una fecha');
    }

    return { valido: errores.length === 0, errores };
}

// Agregar nuevo registro
async function agregarRegistro(e) {
    e.preventDefault();

    // Validar permisos
    if (!auth.estaAutenticado()) {
        mostrarNotificacion('Debes estar autenticado para agregar registros', 'warning');
        return;
    }

    const establecimientoSeleccionado = DOMCache.get('establecimiento')?.value.trim() || '';
    
    // Si es usuario (no admin), validar que solo agregue a su centro
    if (!auth.esAdmin()) {
        const centroUsuario = auth.obtenerCentroActual();
        if (establecimientoSeleccionado !== centroUsuario) {
            mostrarNotificacion(`Solo puedes registrar recetas para tu centro: ${centroUsuario}`, 'warning');
            return;
        }
    }

    // Validar formulario
    const validacion = validarFormularioRegistro();
    if (!validacion.valido) {
        mostrarNotificacion(validacion.errores.join('. '), 'warning');
        return;
    }

    const usuarioActual = auth.obtenerUsuarioActual();
    if (!usuarioActual) {
        mostrarNotificacion('Error: No se pudo obtener información del usuario', 'warning');
        return;
    }

    const registro = {
        id: Date.now() + Math.random(), // Mejorar unicidad del ID
        usuario_registra: usuarioActual.usuario,
        establecimiento: establecimientoSeleccionado,
        producto: DOMCache.producto.value.trim(),
        tipo_servicio: DOMCache.tipoServicio ? DOMCache.tipoServicio.value.trim() : '',
        cantidad_requerida: parseFloat(DOMCache.get('cantidad_requerida').value),
        cantidad_disponible: parseFloat(DOMCache.get('cantidad_disponible').value),
        demanda_no_satisfecha: 0,
        cobertura: 0,
        fecha: DOMCache.get('fecha_registro').value,
        fecha_registro_sistema: new Date().toISOString(),
        observaciones: DOMCache.get('observaciones')?.value.trim() || ''
    };

    // Calcular demanda no satisfecha y cobertura
    registro.demanda_no_satisfecha = Math.max(0, registro.cantidad_requerida - registro.cantidad_disponible);
    registro.cobertura = registro.cantidad_requerida > 0 
        ? parseFloat(((registro.cantidad_disponible / registro.cantidad_requerida) * 100).toFixed(2))
        : 100;

    try {
        // Obtener datos existentes
        let datos = obtenerDatos();
        datos.push(registro);

        // Guardar datos localmente
        localStorage.setItem(STORAGE_KEY, JSON.stringify(datos));

        // Guardar en Google Sheets (Apps Script Web App)
        // Obtener COD PRE del establecimiento si existe en el catálogo cargado
        let cod_pre = '';
        const keyEst = (registro.establecimiento || '').toString().trim().toUpperCase();
        if (window.mapaCodPre && window.mapaCodPre[keyEst]) {
            const codPreRaw = window.mapaCodPre[keyEst];
            // Formatear a 5 dígitos: 1 -> 00001
            const numCodPre = parseInt(codPreRaw, 10);
            cod_pre = isNaN(numCodPre) ? codPreRaw : String(numCodPre).padStart(5, '0');
        } else {
            const codPreFallback = obtenerCodPrePorNombre(registro.establecimiento);
            if (codPreFallback) {
                const numCodPre = parseInt(codPreFallback, 10);
                cod_pre = isNaN(numCodPre) ? codPreFallback : String(numCodPre).padStart(5, '0');
            }
        }

        // Separar código y nombre del producto si es posible
        let codigo_producto = '';
        let producto_nombre = registro.producto;
        const prodMatch = (registro.producto || '').match(/^(?:\[)?(\d{3,})(?:\])?\s*-?\s*(.*)$/);
        if (prodMatch) {
            // Formatear código de producto a 5 dígitos: 91 -> 00091
            const numCodProd = parseInt(prodMatch[1], 10);
            codigo_producto = isNaN(numCodProd) ? prodMatch[1] : String(numCodProd).padStart(5, '0');
            producto_nombre = prodMatch[2] || '';
        }

        (async () => {
            const payload = {
                cod_pre: cod_pre,
                establecimiento: registro.establecimiento,
                codigo_producto: codigo_producto,
                producto: producto_nombre,
                tipo_servicio: registro.tipo_servicio,
                cantidad_requerida: registro.cantidad_requerida,
                cantidad_disponible: registro.cantidad_disponible,
                demanda_no_satisfecha: registro.demanda_no_satisfecha,
                porcentaje_cobertura: registro.cobertura,
                fecha_registro: registro.fecha,
                observaciones: registro.observaciones,
                usuario_registra: registro.usuario_registra,
                fecha_registro_sistema: registro.fecha_registro_sistema
            };

            const envioOk = await enviarRegistroAppsScript(payload);
            if (envioOk === true) {
                mostrarNotificacion('Receta guardada en Google Sheets (Apps Script)', 'success');
            } else if (envioOk === 'nocors') {
                mostrarNotificacion('Envío realizado sin confirmación (CORS). Verifica la hoja.', 'info');
            } else {
                mostrarNotificacion('Receta guardada localmente, pero no en Google Sheets', 'warning');
            }
        })();

        // Limpiar formulario
        DOMCache.get('formRegistro')?.reset();
        establecerFechaHoy();

        // Restaurar red y establecimiento para usuarios no-admin
        if (!auth.esAdmin()) {
            const centroUsuario = auth.obtenerCentroActual();
            
            if (centroUsuario) {
                // Buscar la RED que contiene al centro del usuario
                let redNombre = '';
                if (CATALOGO_ESTABLECIMIENTOS.redes && Array.isArray(CATALOGO_ESTABLECIMIENTOS.redes)) {
                    for (const r of CATALOGO_ESTABLECIMIENTOS.redes) {
                        if (Array.isArray(r.establecimientos) && r.establecimientos.includes(centroUsuario)) {
                            redNombre = r.nombre;
                            break;
                        }
                    }
                }
                
                // Restaurar red si existe
                const selectRed = document.getElementById('red');
                if (selectRed && redNombre) {
                    selectRed.value = redNombre;
                    selectRed.disabled = true;
                    selectRed.setAttribute('aria-disabled', 'true');
                    // Disparar evento change para actualizar lista de establecimientos
                    selectRed.dispatchEvent(new Event('change'));
                }
                
                // Restaurar establecimiento
                const inputEstablecimiento = document.getElementById('establecimiento');
                if (inputEstablecimiento) {
                    inputEstablecimiento.value = centroUsuario;
                    inputEstablecimiento.disabled = true;
                    inputEstablecimiento.readOnly = true;
                    inputEstablecimiento.setAttribute('aria-disabled', 'true');
                    inputEstablecimiento.setAttribute('title', 'Establecimiento asignado por su usuario');
                }
            }
        }

        // Cerrar sugerencias si están abiertas
        if (DOMCache.sugerenciasProductos) {
            DOMCache.sugerenciasProductos.classList.remove('active');
            DOMCache.sugerenciasProductos.innerHTML = '';
        }

        // Mostrar la nueva fila inmediatamente en la tabla
        console.log('📊 Intentando agregar fila a tabla...');
        agregarFilaATabla(registro);
        
        mostrarNotificacion('✓ Registro agregado correctamente', 'success');
        
        // Actualizar tabla y estadísticas (en segundo plano con delay)
        // Esperamos un tiempo para que el usuario vea la nueva fila
        setTimeout(() => {
            cargarDatos().catch(error => {
                console.error('Error actualizando datos:', error);
            });
        }, 1500);
    } catch (error) {
        console.error('Error al guardar registro:', error);
        mostrarNotificacion('Error al guardar el registro. Intenta nuevamente.', 'warning');
    }
}

// Cargar usuarios desde Google Sheets via AppScript
async function cargarUsuariosDesdeAppScript() {
    try {
        const url = `${APPS_SCRIPT_URL}?action=getUsers`;
        // Importante: GET sin headers para evitar preflight/CORS
        const resp = await fetch(url, { method: 'GET' });
        
        if (resp.ok) {
            const result = await resp.json();
            if (result.success && Array.isArray(result.usuarios)) {
                window.USUARIOS_SISTEMA = result.usuarios;
                console.log(`✓ ${result.usuarios.length} usuarios cargados desde Google Sheets`);
                return result.usuarios;
            }
        }
        
        // Fallback: intentar vía POST action=getUsers
        console.warn('GET usuarios no respondió, intentando POST ...');
        try {
            const resp2 = await fetch(APPS_SCRIPT_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'getUsers' })
            });
            let result2 = null;
            try { result2 = await resp2.json(); } catch {}
            if (result2 && result2.success && Array.isArray(result2.usuarios)) {
                window.USUARIOS_SISTEMA = result2.usuarios;
                console.log(`✓ ${result2.usuarios.length} usuarios cargados (POST)`);
                return result2.usuarios;
            }
        } catch (ePost) {
            console.warn('POST usuarios falló:', ePost);
        }
        
        // Fallback final: POST no-cors para forzar creación y luego reintentar GET
        try {
            await fetch(APPS_SCRIPT_URL, {
                method: 'POST',
                mode: 'no-cors',
                headers: { 'Content-Type': 'text/plain' },
                body: JSON.stringify({ action: 'getUsers' })
            });
            await new Promise(r => setTimeout(r, 1000));
            const retry = await fetch(url, { method: 'GET' });
            if (retry.ok) {
                const result3 = await retry.json();
                if (result3.success && Array.isArray(result3.usuarios)) {
                    window.USUARIOS_SISTEMA = result3.usuarios;
                    console.log(`✓ ${result3.usuarios.length} usuarios cargados (reintento)`);
                    return result3.usuarios;
                }
            }
        } catch (eNoCors) {
            console.warn('Fallback no-cors usuarios falló:', eNoCors);
        }
        
        console.warn('No se pudieron cargar usuarios desde Google Sheets');
        return [];
    } catch (error) {
        console.error('Error al cargar usuarios:', error);
        return [];
    }
}

// Guardar usuario en Google Sheets via AppScript
async function guardarUsuarioEnAppScript(usuario) {
    try {
        const payload = {
            action: 'createUser',
            usuario: usuario
        };
        
        const resp = await fetch(APPS_SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        let result = null;
        try { result = await resp.json(); } catch {}
        const ok = (result && (result.status === 'ok' || result.success === true));
        
        if (ok) {
            // Recargar usuarios para mantener sincronizado
            await cargarUsuariosDesdeAppScript();
            return true;
        }
        
        throw new Error('Respuesta no válida del servidor');
    } catch (err) {
        // Fallback no-cors
        try {
            const payload = {
                action: 'createUser',
                usuario: usuario
            };
            
            await fetch(APPS_SCRIPT_URL, {
                method: 'POST',
                mode: 'no-cors',
                headers: { 'Content-Type': 'text/plain' },
                body: JSON.stringify(payload)
            });
            
            // Esperar un momento y recargar usuarios
            await new Promise(resolve => setTimeout(resolve, 1000));
            await cargarUsuariosDesdeAppScript();
            return 'nocors';
        } catch (e2) {
            console.warn('Fallo al guardar usuario en Apps Script:', e2);
            return false;
        }
    }
}

// Enviar registro al Apps Script con fallback CORS
async function enviarRegistroAppsScript(payload) {
    try {
        console.log('📤 Enviando registro a Google Sheets via Apps Script...');
        console.log('URL:', APPS_SCRIPT_URL);
        console.log('Datos:', payload);
        
        const resp = await fetch(APPS_SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        console.log('Respuesta HTTP:', resp.status, resp.statusText);
        
        // Intentar leer JSON (Apps Script puede responder {status:'ok'} o {success:true})
        let result = null;
        try { result = await resp.json(); } catch {}
        
        console.log('Respuesta JSON:', result);
        
        const ok = (result && (result.status === 'ok' || result.result === 'ok' || result.success === true));
        if (ok) {
            console.log('✅ ENVIADO Y CONFIRMADO en Google Sheets');
            return true;
        }
        
        // Si no hay confirmación clara, pero respuesta 200, asumir envío sin confirmación
        if (resp.ok) {
            console.log('⚠️ Respuesta 200 pero sin confirmación explícita');
            // Guardar en cola para reintentar
            guardarEnColaSync(payload);
            return 'nocors';
        }
        
        // Error HTTP real
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
        
    } catch (err) {
        console.error('❌ ERROR en primer intento:', err.message);
        
        // Segundo intento: modo no-cors (sin validar respuesta)
        try {
            console.log('🔄 Reintentando con mode: no-cors...');
            await fetch(APPS_SCRIPT_URL, {
                method: 'POST',
                mode: 'no-cors',
                headers: { 'Content-Type': 'text/plain' },
                body: JSON.stringify(payload)
            });
            
            console.log('⚠️ ENVIADO en modo no-cors (sin confirmación)');
            // Guardar en cola para sincronizar después
            guardarEnColaSync(payload);
            return 'nocors';
            
        } catch (e2) {
            console.error('❌ FALLO TOTAL:', e2 && e2.message ? e2.message : e2);
            
            // Guardar en cola para reintentar después
            guardarEnColaSync(payload);
            return false;
        }
    }
}

// Guardar registro en cola si falla el envío a Google Sheets
function guardarEnColaSync(payload) {
    try {
        const COLA_KEY = 'recetas_cola_sync';
        let cola = [];
        
        const colaGuardada = localStorage.getItem(COLA_KEY);
        if (colaGuardada) {
            cola = JSON.parse(colaGuardada);
        }
        
        // Agregar con timestamp
        payload._timestampIntento = new Date().toISOString();
        cola.push(payload);
        
        localStorage.setItem(COLA_KEY, JSON.stringify(cola));
        console.log(`⏳ Guardado en cola de sincronización (${cola.length} items pendientes)`);
        
    } catch (e) {
        console.warn('No se pudo guardar en cola:', e);
    }
}

// Obtener datos de localStorage
function obtenerDatos() {
    const datos = localStorage.getItem(STORAGE_KEY);
    return datos ? JSON.parse(datos) : [];
}

// Cargar registros desde Google Sheets via AppScript
async function cargarRegistrosDesdeAppScript() {
    try {
        console.log('=== INICIANDO CARGA DESDE GOOGLE SHEETS ===');
        const url = `${APPS_SCRIPT_URL}?action=getRecetas`;
        console.log('URL:', url);
        
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout')), 10000)
        );
        
        const resp = await Promise.race([
            fetch(url, { method: 'GET', cache: 'no-store' }),
            timeoutPromise
        ]);
        
        console.log('Respuesta HTTP:', resp.status);
        
        if (resp.ok) {
            const result = await resp.json();
            console.log('✅ Recibida respuesta:', result);
            
            if (result.success && Array.isArray(result.recetas)) {
                console.log(`✅ ${result.recetas.length} registros cargados`);
                return result.recetas;
            } else {
                console.warn('⚠️ Respuesta inválida');
                return obtenerDatos();
            }
        } else {
            console.error('❌ Error HTTP:', resp.status);
            return obtenerDatos();
        }
        
    } catch (error) {
        console.error('❌ Error:', error);
        return obtenerDatos();
    }
}

// Variable global para almacenar datos filtrados
let datosActualesFiltrados = [];

// Cargar y mostrar datos
async function cargarDatos() {
    try {
        // Cargar todos los datos
        let datos = await cargarRegistrosDesdeAppScript();
        
        if (!Array.isArray(datos)) {
            datos = [];
        }
        
        console.log('📊 Total de registros cargados:', datos.length);
        
        // Obtener usuario actual
        const usuarioActual = auth.obtenerUsuarioActual && auth.obtenerUsuarioActual();
        console.log('👤 Usuario actual:', usuarioActual);
        console.log('  - Usuario:', usuarioActual?.usuario);
        console.log('  - Rol:', usuarioActual?.rol);
        console.log('  - Centro:', usuarioActual?.centro);
        
        // APLICAR FILTRADO
        let datosFiltrados = datos;
        
        if (usuarioActual) {
            const esAdmin = usuarioActual.rol === 'admin';
            const centroUsuario = usuarioActual.centro;
            
            console.log('🔐 esAdmin:', esAdmin, '| centroUsuario:', centroUsuario);
            
            if (esAdmin) {
                // ADMIN: ve todo
                console.log('✅ Es ADMIN - mostrando todos los', datos.length, 'registros');
                datosFiltrados = datos;
            } else if (centroUsuario) {
                // USUARIO REGULAR: filtra por centro
                const centroNorm = centroUsuario.trim().toUpperCase();
                console.log('🔍 Filtrando por centro:', centroNorm);
                
                datosFiltrados = datos.filter(registro => {
                    const estabNorm = (registro.establecimiento || '').trim().toUpperCase();
                    const coincide = estabNorm === centroNorm;
                    if (coincide) {
                        console.log(`  ✓ "${registro.establecimiento}" coincide`);
                    }
                    return coincide;
                });
                
                console.log(`🔍 Resultado del filtro: ${datosFiltrados.length}/${datos.length} registros`);
            } else {
                // Sin centro asignado
                console.warn('⚠️ Usuario sin centro asignado - sin datos');
                datosFiltrados = [];
            }
        } else {
            console.warn('⚠️ No hay usuario autenticado');
            datosFiltrados = [];
        }
        
        // Guardar datos filtrados globalmente
        datosActualesFiltrados = datosFiltrados;
        
        // Obtener estado admin para pasar a mostrarTabla
        const esAdminFinal = usuarioActual && usuarioActual.rol === 'admin';
        
        console.log('🎬 LLAMANDO mostrarTabla con:');
        console.log('  - datosFiltrados.length:', datosFiltrados.length);
        console.log('  - esAdminFinal:', esAdminFinal);
        console.log('  - esAdminFinal === true?:', esAdminFinal === true);
        
        mostrarTabla(datosFiltrados, esAdminFinal);
        actualizarEstadisticas(datosFiltrados);
        actualizarProductosCriticos(datosFiltrados);
        
    } catch (error) {
        console.error('❌ Error:', error);
        console.error('Stack:', error.stack);
        mostrarNotificacion('Error al cargar datos', 'warning');
    }
}

// Escapar HTML para prevenir XSS
function escaparHTML(texto) {
    if (texto == null) return '';
    const div = document.createElement('div');
    div.textContent = texto;
    return div.innerHTML;
}

// Determinar clase CSS según demanda
function obtenerClaseDemanda(demandaNoSatisfecha, cantidadRequerida) {
    if (demandaNoSatisfecha === 0) return 'demanda-bajo';
    const porcentaje = cantidadRequerida > 0 ? (demandaNoSatisfecha / cantidadRequerida) : 0;
    return porcentaje >= 0.3 ? 'demanda-alto' : 'demanda-medio';
}

// Función auxiliar para generar botón de eliminar (solo para admin)
function generarBotonesAccion(registroId, esAdmin) {
    console.log('🔍 Generando botones - registroId:', registroId, '| esAdmin:', esAdmin, '(tipo:', typeof esAdmin, ')');
    
    // Verificar explícitamente si esAdmin es true
    if (esAdmin === true) {
        console.log('✓ Es admin - mostrando botón eliminar');
        return `<button class="btn btn-danger" onclick="eliminarRegistro(${registroId})" aria-label="Eliminar registro">🗑️ Eliminar</button>`;
    }
    
    console.log('✗ No es admin (esAdmin=', esAdmin, ') - mostrando "Ver solo"');
    return '<span style="color: #999; font-size: 0.9em;">Ver solo</span>';
}

// Agregar una fila a la tabla de inmediato (sin esperar cargarDatos)
function agregarFilaATabla(registro) {
    const tbody = DOMCache.cuerpoTabla;
    if (!tbody) {
        console.warn('⚠️ No se pudo encontrar el tbody de la tabla');
        return;
    }
    
    console.log('✓ Agregando fila a tabla:', registro);
    
    // Obtener estado admin actual
    const esAdmin = auth.esAdmin && auth.esAdmin();
    console.log('🔐 esAdmin en agregarFilaATabla:', esAdmin, 'tipo:', typeof esAdmin);
    
    // Si hay mensaje de estado vacío, removerlo
    const emptyState = tbody.querySelector('.empty-state');
    if (emptyState) {
        emptyState.remove();
    }
    
    // Obtener el número de fila actual DIRECTO del DOM
    const filasActuales = Array.from(tbody.querySelectorAll('tr')).length;
    const numeroFila = filasActuales + 1;
    
    const tr = document.createElement('tr');
    const clasedemanda = obtenerClaseDemanda(registro.demanda_no_satisfecha, registro.cantidad_requerida);
    
    // Generar botones ANTES de construir el HTML
    const botonesHTML = generarBotonesAccion(registro.id, esAdmin);
    console.log('  🔘 Botones generados para fila', numeroFila, ':', botonesHTML.substring(0, 50) + '...');
    
    tr.innerHTML = `
        <td>${numeroFila}</td>
        <td><strong>${escaparHTML(registro.establecimiento)}</strong></td>
        <td>${escaparHTML(registro.producto)}</td>
        <td>${escaparHTML(registro.tipo_servicio || 'No especificado')}</td>
        <td>${registro.cantidad_requerida}</td>
        <td>${registro.cantidad_disponible}</td>
        <td class="${clasedemanda}">${registro.demanda_no_satisfecha}</td>
        <td>${registro.cobertura}%</td>
        <td>${formatearFecha(registro.fecha)}</td>
        <td>
            ${botonesHTML}
        </td>
    `;
    
    // Agregar la fila al final de la tabla
    tbody.appendChild(tr);
    
    console.log('✓ Fila agregada exitosamente a la tabla. Total filas ahora:', numeroFila);
    
    // Hacer scroll a la nueva fila después de un pequeño delay
    setTimeout(() => {
        try {
            tr.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } catch (e) {
            console.warn('No se pudo hacer scroll:', e);
        }
    }, 50);
}

// Mostrar tabla (optimizada)
function mostrarTabla(datos, esAdmin = false) {
    console.log('📊 mostrarTabla - datos:', datos.length, '| esAdmin:', esAdmin, 'tipo:', typeof esAdmin);
    const tbody = DOMCache.cuerpoTabla;
    if (!tbody) {
        console.error('❌ No se encontró tbody');
        return;
    }
    
    if (datos.length === 0) {
        console.log('📋 Sin datos, mostrando estado vacío');
        tbody.innerHTML = '<tr class="empty-state"><td colspan="10">No hay registros. Completa el formulario para comenzar.</td></tr>';
        return;
    }

    // Usar DocumentFragment para mejor rendimiento
    const fragment = document.createDocumentFragment();
    
    datos.forEach((registro, index) => {
        const tr = document.createElement('tr');
        const clasedemanda = obtenerClaseDemanda(registro.demanda_no_satisfecha, registro.cantidad_requerida);
        
        // Generar botones ANTES de construir el HTML
        const botonesHTML = generarBotonesAccion(registro.id, esAdmin);
        console.log(`  📌 Registro ${index + 1}: generando botones con esAdmin=${esAdmin}`);
        
        tr.innerHTML = `
            <td>${index + 1}</td>
            <td><strong>${escaparHTML(registro.establecimiento)}</strong></td>
            <td>${escaparHTML(registro.producto)}</td>
            <td>${escaparHTML(registro.tipo_servicio || 'No especificado')}</td>
            <td>${registro.cantidad_requerida}</td>
            <td>${registro.cantidad_disponible}</td>
            <td class="${clasedemanda}">${registro.demanda_no_satisfecha}</td>
            <td>${registro.cobertura}%</td>
            <td>${formatearFecha(registro.fecha)}</td>
            <td>
                ${botonesHTML}
            </td>
        `;
        
        fragment.appendChild(tr);
    });
    
    tbody.innerHTML = '';
    tbody.appendChild(fragment);
    
    // LOG DE DEPURACIÓN: Verificar que los botones están en el DOM
    const botonesEnTabla = tbody.querySelectorAll('button.btn-danger');
    console.log('✅ Tabla actualizada con', datos.length, 'registros');
    console.log('🔘 Botones DELETE en la tabla:', botonesEnTabla.length, 'encontrados');
    botonesEnTabla.forEach((btn, idx) => {
        console.log(`   Botón ${idx + 1}:`, btn.textContent, 'onclick:', btn.getAttribute('onclick'));
    });
}

// Eliminar registro (mejorado)
async function eliminarRegistro(id) {
    // Validar permisos - SOLO ADMIN puede eliminar
    if (!auth.estaAutenticado()) {
        mostrarNotificacion('Debes estar autenticado para eliminar registros', 'warning');
        return;
    }

    // Solo el administrador puede eliminar registros
    if (!auth.esAdmin()) {
        mostrarNotificacion('Solo los administradores pueden eliminar registros', 'warning');
        return;
    }

    if (confirm('¿Estás seguro de que deseas eliminar este registro?')) {
        try {
            let datos = obtenerDatos();
            const registroEliminado = datos.find(r => r.id === id);
            
            if (!registroEliminado) {
                mostrarNotificacion('Registro no encontrado', 'warning');
                return;
            }
            
            datos = datos.filter(r => r.id !== id);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(datos));
            
            // Sincronizar con Google Sheets
            if (typeof enviarRegistroAppsScript === 'function') {
                fetch(APPS_SCRIPT_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'deleteReceta', id: id })
                }).catch(e => console.warn('No se pudo eliminar en Google Sheets:', e));
            }
            
            await cargarDatos();
            mostrarNotificacion('Registro eliminado exitosamente', 'info');
        } catch (error) {
            console.error('Error al eliminar registro:', error);
            mostrarNotificacion('Error al eliminar el registro', 'warning');
        }
    }
}

// Actualizar estadísticas
function actualizarEstadisticas(datos) {
    // Total registros
    document.getElementById('totalRegistros').textContent = datos.length;

    // Productos distintos
    const productosUnicos = new Set(datos.map(d => d.producto));
    document.getElementById('totalProductos').textContent = productosUnicos.size;

    // Establecimientos únicos
    const establecimientosUnicos = new Set(datos.map(d => d.establecimiento));
    document.getElementById('totalEstablecimientos').textContent = establecimientosUnicos.size;

    // Total demanda no satisfecha
    const totalDemanda = datos.reduce((sum, d) => sum + d.demanda_no_satisfecha, 0);
    document.getElementById('totalDemandaNoSatisfecha').textContent = totalDemanda;
}

// Actualizar productos críticos (optimizado)
function actualizarProductosCriticos(datos) {
    const productosCon = new Map();

    // Agrupar por producto y sumar demanda no satisfecha (usando Map para mejor rendimiento)
    datos.forEach(registro => {
        if (registro.demanda_no_satisfecha > 0) {
            const clave = registro.producto;
            if (!productosCon.has(clave)) {
                productosCon.set(clave, {
                    producto: registro.producto,
                    demanda_total: 0,
                    registros: 0
                });
            }
            const producto = productosCon.get(clave);
            producto.demanda_total += registro.demanda_no_satisfecha;
            producto.registros += 1;
        }
    });

    const productos = Array.from(productosCon.values())
        .sort((a, b) => b.demanda_total - a.demanda_total);

    const contenedor = DOMCache.get('productosCriticos');
    if (!contenedor) return;

    if (productos.length === 0) {
        contenedor.innerHTML = '<p class="empty-state">Sin productos con demanda no satisfecha.</p>';
        return;
    }

    // Usar DocumentFragment para mejor rendimiento
    const fragment = document.createDocumentFragment();
    const tempDiv = document.createElement('div');
    
    productos.forEach(p => {
        const item = document.createElement('div');
        item.className = 'critical-item';
        item.innerHTML = `
            <div class="critical-info">
                <h4>${escaparHTML(p.producto)}</h4>
                <p>${p.registros} establecimiento(s) reportan esta falta</p>
            </div>
            <div class="critical-number">
                ${p.demanda_total} unidades
            </div>
        `;
        fragment.appendChild(item);
    });
    
    contenedor.innerHTML = '';
    contenedor.appendChild(fragment);
}

// Filtrar tabla (con debounce para mejor rendimiento)
const filtrarTablaDebounced = debounce(async () => {
    const busqueda = DOMCache.filtroBusqueda?.value.toLowerCase().trim() || '';
    let datos = await cargarRegistrosDesdeAppScript(); // Cargar datos frescos
    
    // Obtener estado admin
    const usuarioActual = auth.obtenerUsuarioActual && auth.obtenerUsuarioActual();
    const esAdmin = usuarioActual && usuarioActual.rol === 'admin';
    
    if (!busqueda) {
        mostrarTabla(datos, esAdmin);
        return;
    }
    
    const datosFiltrados = datos.filter(registro => {
        const establecimiento = (registro.establecimiento || '').toLowerCase();
        const producto = (registro.producto || '').toLowerCase();
        const tipoServicio = (registro.tipo_servicio || '').toLowerCase();
        return establecimiento.includes(busqueda) || 
               producto.includes(busqueda) || 
               tipoServicio.includes(busqueda);
    });

    mostrarTabla(datosFiltrados, esAdmin);
}, DEBOUNCE_DELAY);

// Función wrapper para mantener compatibilidad
function filtrarTabla() {
    filtrarTablaDebounced();
}

// Limpiar todos los datos (mejorado con validación de permisos)
async function limpiarDatos() {
    // Solo admin puede limpiar todos los datos
    if (!auth.esAdmin()) {
        mostrarNotificacion('Solo los administradores pueden limpiar todos los datos', 'warning');
        return;
    }
    
    if (confirm('⚠️ Advertencia: Esto eliminará TODOS los registros. ¿Estás seguro?')) {
        try {
            localStorage.removeItem(STORAGE_KEY);
            
            // Intentar limpiar también en Google Sheets
            if (typeof enviarRegistroAppsScript === 'function') {
                fetch(APPS_SCRIPT_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'deleteAllRecetas' })
                }).catch(e => console.warn('No se pudo limpiar en Google Sheets:', e));
            }
            
            await cargarDatos();
            mostrarNotificacion('Todos los datos han sido eliminados', 'warning');
        } catch (error) {
            console.error('Error al limpiar datos:', error);
            mostrarNotificacion('Error al limpiar los datos', 'warning');
        }
    }
}

// Exportar a Excel con formato y resumen (mejorado)
async function exportarCSV() {
    // Usar los datos filtrados que están actualmente en la tabla
    let datos = datosActualesFiltrados;

    if (!datos || datos.length === 0) {
        mostrarNotificacion('No hay datos para exportar', 'info');
        return;
    }

    try {
        if (typeof XLSX === 'undefined') {
            mostrarNotificacion('Error: La librería XLSX no está cargada', 'warning');
            return;
        }

        // Intentar cargar mapa COD PRE desde catalogo_establecimientos.json
        let mapaCodPre = {};
        
        // Función para normalizar nombres (quitar puntos, espacios múltiples, etc)
        const normalizarNombre = (text) => {
            return (text || '')
                .toString()
                .trim()
                .toUpperCase()
                .replace(/\s+/g, ' ')      // espacios múltiples a uno
                .replace(/\./g, '')         // quitar puntos
                .replace(/\s*-\s*/g, '-');  // normalizar guiones
        };
        
        try {
            const resp = await fetch('catalogo_establecimientos.json');
            if (resp && resp.ok) {
                const data = await resp.json();
                // Extraer establecimientos de todas las redes
                if (data.redes && Array.isArray(data.redes)) {
                    data.redes.forEach(red => {
                        if (red.establecimientos && Array.isArray(red.establecimientos)) {
                            red.establecimientos.forEach(est => {
                                if (est.nombre && est.cod_pre) {
                                    const nombreNormalizado = normalizarNombre(est.nombre);
                                    const cod = est.cod_pre.toString().trim();
                                    mapaCodPre[nombreNormalizado] = cod;
                                }
                            });
                        }
                    });
                }
                console.log('✓ Mapa de COD PRE cargado desde JSON - Primeros 5:', Object.keys(mapaCodPre).slice(0, 5));
                console.log('  Total centros en mapa:', Object.keys(mapaCodPre).length);
                console.log('  Buscando: "P S SANTA ROSA DE PACHACUTEC" ->', mapaCodPre['P S SANTA ROSA DE PACHACUTEC']);
            }
        } catch (e) {
            console.warn('No se pudo cargar catalogo_establecimientos.json para COD PRE:', e && e.message ? e.message : e);
        }

        // Exponer el mapa COD PRE globalmente para que otras operaciones (p.ej. guardar registro) lo utilicen
        window.mapaCodPre = mapaCodPre;

        // Crear workbook
        const wb = XLSX.utils.book_new();

        // ==========================================
        // HOJA 1: DATOS DETALLADOS
        // ==========================================
        // Construir encabezados: siempre mostrar COD PRE antes del Establecimiento
        const encabezados = [
            'N°',
            'COD PRE',
            'Establecimiento',
            'Código Producto',
            'Producto',
            'Tipo de Servicio',
            'Cantidad Requerida',
            'Cantidad Disponible',
            'Demanda No Satisfecha',
            'Cobertura (%)',
            'Fecha',
            'Observaciones',
            'Usuario que Registró',
            'Fecha de Registro'
        ];

        // Función para separar código y nombre del producto (ej. "[00091] NOMBRE")
        function separarCodigoProducto(text) {
            const s = (text || '').toString().trim();
            const m = s.match(/^\s*\[?\s*(\d+)\s*\]?\s*(.*)$/);
            if (m) return { codigo: m[1], nombre: m[2].trim() };
            // intentar extraer código entre paréntesis o al inicio
            const m2 = s.match(/^(\d{3,})\s*-?\s*(.*)$/);
            if (m2) return { codigo: m2[1], nombre: m2[2].trim() };
            return { codigo: '', nombre: s };
        }

        const datosHoja = datos.map((d, index) => {
            const establecimiento = (d.establecimiento || '').toString().trim();
            const key = normalizarNombre(establecimiento);
            let codPreVal = mapaCodPre[key] || '';
            // Formatear COD PRE a 5 dígitos
            if (codPreVal) {
                const numCodPre = parseInt(codPreVal, 10);
                codPreVal = isNaN(numCodPre) ? codPreVal : String(numCodPre).padStart(5, '0');
            }
            
            // Intentar obtener código de producto de dos maneras:
            // 1. Directamente del campo codigo_producto
            // 2. Extrayendo del nombre del producto si tiene formato "[CODIGO] - NOMBRE"
            let codigoProd = '';
            let prodNombre = '';
            
            if (d.codigo_producto) {
                // Si el campo existe, usarlo
                codigoProd = (d.codigo_producto || '').toString().trim();
                prodNombre = (d.producto || '').toString().trim();
            } else {
                // Si no existe, intentar extraer del producto
                const prod = separarCodigoProducto(d.producto || '');
                codigoProd = prod.codigo || '';
                prodNombre = prod.nombre || '';
            }
            
            // Formatear código de producto a 5 dígitos
            let codigoProdFormateado = codigoProd || '';
            if (codigoProdFormateado) {
                const numCodProd = parseInt(codigoProdFormateado, 10);
                codigoProdFormateado = isNaN(numCodProd) ? codigoProdFormateado : String(numCodProd).padStart(5, '0');
            }
            
            return [
                index + 1,
                codPreVal || '',
                establecimiento || '',
                codigoProdFormateado || '',
                prodNombre || '',
                d.tipo_servicio || 'No especificado',
                d.cantidad_requerida || 0,
                d.cantidad_disponible || 0,
                d.demanda_no_satisfecha || 0,
                parseFloat(d.cobertura) || 0,
                d.fecha || '',
                d.observaciones || '',
                d.usuario_registra || '',
                d.fecha_registro_sistema ? new Date(d.fecha_registro_sistema).toLocaleString('es-ES') : ''
            ];
        });

        // Crear worksheet
        const ws = XLSX.utils.aoa_to_sheet([encabezados, ...datosHoja]);

        // Ajustar ancho de columnas para mejor visualización
        ws['!cols'] = [
            { wch: 5 },   // N°
            { wch: 10 },  // COD PRE
            { wch: 30 },  // Establecimiento
            { wch: 12 },  // Código Producto
            { wch: 40 },  // Producto
            { wch: 30 },  // Tipo de Servicio
            { wch: 18 },  // Cantidad Requerida
            { wch: 18 },  // Cantidad Disponible
            { wch: 20 },  // Demanda No Satisfecha
            { wch: 15 },  // Cobertura (%)
            { wch: 12 },  // Fecha
            { wch: 30 },  // Observaciones
            { wch: 20 },  // Usuario que Registró
            { wch: 20 }   // Fecha de Registro
        ];

        // Agregar hoja al workbook
        XLSX.utils.book_append_sheet(wb, ws, "Datos Detallados");

        // ==========================================
        // HOJA 2: RESUMEN POR CENTRO
        // ==========================================
        if (auth.esAdmin()) {
            // Solo admin ve resumen de todos los centros
            const todosLosDatos = obtenerDatos(); // Todos los datos sin filtrar
            const resumenPorCentro = generarResumenPorCentro(todosLosDatos);
            const wsResumen = crearHojaResumen(resumenPorCentro);
            XLSX.utils.book_append_sheet(wb, wsResumen, "Resumen por Centro");
        } else {
            // Usuario de centro ve su resumen
            const resumenPorCentro = generarResumenPorCentro(datos);
            const wsResumen = crearHojaResumen(resumenPorCentro);
            XLSX.utils.book_append_sheet(wb, wsResumen, "Mi Resumen");
        }

        // Generar archivo Excel
        const fecha = new Date().toISOString().split('T')[0];
        const centroActual = auth.obtenerCentroActual();
        const nombreArchivo = auth.esAdmin() 
            ? `Recetas_No_Atendidas_Todos_${fecha}.xlsx`
            : `Recetas_${(centroActual || 'Centro').replace(/\s+/g, '_')}_${fecha}.xlsx`;

        XLSX.writeFile(wb, nombreArchivo);

        mostrarNotificacion('Archivo Excel descargado exitosamente', 'success');
    } catch (error) {
        console.error('Error al exportar Excel:', error);
        mostrarNotificacion('Error al exportar el archivo Excel: ' + error.message, 'warning');
    }
}

// Obtener lista de productos críticos
function obtenerProductosCriticos() {
    const datos = datosActualesFiltrados || [];
    const productosCon = new Map();

    datos.forEach(registro => {
        if (registro.demanda_no_satisfecha > 0) {
            const clave = registro.producto;
            if (!productosCon.has(clave)) {
                productosCon.set(clave, {
                    producto: registro.producto,
                    demandaTotal: 0,
                    registros: 0
                });
            }
            const producto = productosCon.get(clave);
            producto.demandaTotal += registro.demanda_no_satisfecha;
            producto.registros += 1;
        }
    });

    return Array.from(productosCon.values())
        .sort((a, b) => b.demandaTotal - a.demandaTotal);
}

// Exportar solo resumen estadístico en Excel
async function exportarResumenExcel() {
    try {
        if (typeof XLSX === 'undefined') {
            mostrarNotificacion('Error: La librería XLSX no está cargada', 'warning');
            return;
        }

        const datos = datosActualesFiltrados;
        if (!datos || datos.length === 0) {
            mostrarNotificacion('No hay datos para exportar', 'info');
            return;
        }

        // Cargar mapa COD PRE desde catalogo_establecimientos.json
        let mapaCodPre = {};
        try {
            const resp = await fetch('catalogo_establecimientos.json');
            if (resp && resp.ok) {
                const data = await resp.json();
                // Extraer establecimientos de todas las redes
                if (data.redes && Array.isArray(data.redes)) {
                    data.redes.forEach(red => {
                        if (red.establecimientos && Array.isArray(red.establecimientos)) {
                            red.establecimientos.forEach(est => {
                                if (est.nombre && est.cod_pre) {
                                    const nombre = est.nombre.toString().trim().toUpperCase();
                                    const cod = est.cod_pre.toString().trim();
                                    // Normalizar espacios múltiples a uno solo
                                    const nombreNormalizado = nombre.replace(/\s+/g, ' ');
                                    mapaCodPre[nombreNormalizado] = cod;
                                }
                            });
                        }
                    });
                }
            }
        } catch (e) {
            console.warn('No se pudo cargar catalogo_establecimientos.json:', e && e.message ? e.message : e);
        }

        // Crear workbook
        const wb = XLSX.utils.book_new();

        // ==========================================
        // HOJA 1: ESTADÍSTICAS GENERALES
        // ==========================================
        const statsData = [
            ['RESUMEN GENERAL', ''],
            ['', ''],
            ['Total Registros', obtenerDatos().length],
            ['Total Registros (Filtrados)', datos.length],
            ['Productos Distintos', new Set(datos.map(d => d.codigo_producto)).size],
            ['Establecimientos', new Set(datos.map(d => d.establecimiento)).size],
            ['Total Demanda No Satisfecha', datos.reduce((sum, d) => sum + (parseInt(d.demanda_no_satisfecha) || 0), 0)],
            ['', ''],
            ['PRODUCTOS CRÍTICOS (Demanda > 0)', ''],
            ['', '']
        ];

        const productosCriticos = obtenerProductosCriticos();
        productosCriticos.forEach(pc => {
            statsData.push([pc.producto, pc.demandaTotal]);
        });

        const ws1 = XLSX.utils.aoa_to_sheet(statsData);
        ws1['!cols'] = [{ wch: 40 }, { wch: 15 }];

        // Agregar estilos básicos
        for (let row in ws1) {
            if (row.startsWith('A') && !row.includes('!')) {
                if (statsData[parseInt(row.substring(1)) - 1]?.[0]?.includes('RESUMEN') || 
                    statsData[parseInt(row.substring(1)) - 1]?.[0]?.includes('CRÍTICOS')) {
                    ws1[row].s = { font: { bold: true, size: 12 }, fill: { fgColor: { rgb: 'FF6B7280' } } };
                }
            }
        }

        XLSX.utils.book_append_sheet(wb, ws1, "Resumen");

        // ==========================================
        // HOJA 2: DETALLE POR CENTRO (Si es Admin)
        // ==========================================
        if (auth.esAdmin()) {
            const resumenPorCentro = generarResumenPorCentro(datos);
            const ws2 = crearHojaResumen(resumenPorCentro);
            XLSX.utils.book_append_sheet(wb, ws2, "Por Centro");
        }

        // Generar archivo
        const fecha = new Date().toISOString().split('T')[0];
        const nombreArchivo = `Resumen_Recetas_${fecha}.xlsx`;
        XLSX.writeFile(wb, nombreArchivo);

        mostrarNotificacion('Resumen descargado exitosamente', 'success');
    } catch (error) {
        console.error('Error al exportar resumen:', error);
        mostrarNotificacion('Error al exportar: ' + error.message, 'warning');
    }
}

// Generar resumen por centro
function generarResumenPorCentro(datos) {
    const resumen = {};
    
    datos.forEach(registro => {
        const centro = registro.establecimiento || 'Sin especificar';
        
        if (!resumen[centro]) {
            resumen[centro] = {
                centro: centro,
                totalRegistros: 0,
                productosUnicos: new Set(),
                totalRequerida: 0,
                totalDisponible: 0,
                totalDemandaNoSatisfecha: 0,
                tiposServicio: new Set(),
                productosCriticos: []
            };
        }
        
        resumen[centro].totalRegistros++;
        resumen[centro].productosUnicos.add(registro.producto);
        resumen[centro].totalRequerida += registro.cantidad_requerida || 0;
        resumen[centro].totalDisponible += registro.cantidad_disponible || 0;
        resumen[centro].totalDemandaNoSatisfecha += registro.demanda_no_satisfecha || 0;
        if (registro.tipo_servicio) {
            resumen[centro].tiposServicio.add(registro.tipo_servicio);
        }
        
        if (registro.demanda_no_satisfecha > 0) {
            resumen[centro].productosCriticos.push({
                producto: registro.producto,
                demanda: registro.demanda_no_satisfecha
            });
        }
    });
    
    // Convertir Sets a números y calcular porcentajes
    return Object.values(resumen).map(item => {
        const coberturaPromedio = item.totalRequerida > 0 
            ? ((item.totalDisponible / item.totalRequerida) * 100).toFixed(2)
            : 100;
        
        // Agrupar productos críticos
        const productosCriticosMap = {};
        item.productosCriticos.forEach(p => {
            if (!productosCriticosMap[p.producto]) {
                productosCriticosMap[p.producto] = 0;
            }
            productosCriticosMap[p.producto] += p.demanda;
        });
        
        const productosCriticosTop = Object.entries(productosCriticosMap)
            .map(([producto, demanda]) => ({ producto, demanda }))
            .sort((a, b) => b.demanda - a.demanda)
            .slice(0, 5);
        
        const productosCriticosTexto = productosCriticosTop.length > 0
            ? productosCriticosTop.map(p => `${p.producto} (${p.demanda})`).join('; ')
            : 'Ninguno';
        
        return {
            centro: item.centro,
            totalRegistros: item.totalRegistros,
            productosUnicos: item.productosUnicos.size,
            totalRequerida: item.totalRequerida,
            totalDisponible: item.totalDisponible,
            totalDemandaNoSatisfecha: item.totalDemandaNoSatisfecha,
            coberturaPromedio: parseFloat(coberturaPromedio),
            tiposServicio: item.tiposServicio.size,
            productosCriticosTop: productosCriticosTexto
        };
    });
}

// Crear hoja de resumen con formato
function crearHojaResumen(resumen) {
    const encabezados = [
        'Centro',
        'Total Registros',
        'Productos Únicos',
        'Total Requerida',
        'Total Disponible',
        'Demanda No Satisfecha',
        'Cobertura Promedio (%)',
        'Tipos de Servicio',
        'Productos Críticos (Top 5)'
    ];
    
    const datosResumen = resumen.map(item => [
        item.centro,
        item.totalRegistros,
        item.productosUnicos,
        item.totalRequerida,
        item.totalDisponible,
        item.totalDemandaNoSatisfecha,
        item.coberturaPromedio,
        item.tiposServicio,
        item.productosCriticosTop || 'Ninguno'
    ]);
    
    const ws = XLSX.utils.aoa_to_sheet([encabezados, ...datosResumen]);
    
    // Ajustar ancho de columnas
    ws['!cols'] = [
        { wch: 30 },  // Centro
        { wch: 15 },  // Total Registros
        { wch: 18 },  // Productos Únicos
        { wch: 18 },  // Total Requerida
        { wch: 18 },  // Total Disponible
        { wch: 22 },  // Demanda No Satisfecha
        { wch: 20 },  // Cobertura Promedio (%)
        { wch: 18 },  // Tipos de Servicio
        { wch: 50 }   // Productos Críticos
    ];
    
    // Ajustar ancho de columnas para mejor visualización
    ws['!cols'] = [
        { wch: 30 },  // Centro
        { wch: 15 },  // Total Registros
        { wch: 18 },  // Productos Únicos
        { wch: 18 },  // Total Requerida
        { wch: 18 },  // Total Disponible
        { wch: 22 },  // Demanda No Satisfecha
        { wch: 20 },  // Cobertura Promedio (%)
        { wch: 18 },  // Tipos de Servicio
        { wch: 50 }   // Productos Críticos
    ];
    
    return ws;
}

// Formatear fecha
function formatearFecha(fecha) {
    if (!fecha) return '';
    
    // Si la fecha está en formato YYYY-MM-DD (sin hora), tratarla como fecha local
    if (/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
        const [año, mes, dia] = fecha.split('-');
        return `${dia}/${mes}/${año}`;
    }
    
    // Si tiene hora, usar toLocaleDateString
    const opciones = { year: 'numeric', month: '2-digit', day: '2-digit' };
    return new Date(fecha).toLocaleDateString('es-ES', opciones);
}

// Mostrar notificaciones
function mostrarNotificacion(mensaje, tipo = 'info') {
    // Crear elemento de notificación
    const notificacion = document.createElement('div');
    notificacion.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 15px 20px;
        background: ${tipo === 'success' ? '#28a745' : tipo === 'warning' ? '#ffc107' : '#17a2b8'};
        color: ${tipo === 'warning' ? '#333' : 'white'};
        border-radius: 5px;
        box-shadow: 0 5px 15px rgba(0,0,0,0.2);
        z-index: 9999;
        animation: slideIn 0.3s ease-in-out;
    `;
    notificacion.textContent = mensaje;
    document.body.appendChild(notificacion);

    // Eliminar después de 3 segundos
    setTimeout(() => {
        notificacion.style.animation = 'slideOut 0.3s ease-in-out';
        setTimeout(() => notificacion.remove(), 300);
    }, 3000);
}

// Agregar estilos de animación
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from {
            transform: translateX(100%);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }
    
    @keyframes slideOut {
        from {
            transform: translateX(0);
            opacity: 1;
        }
        to {
            transform: translateX(100%);
            opacity: 0;
        }
    }
`;
document.head.appendChild(style);

// ====================================
// SISTEMA DE AUTENTICACIÓN
// ====================================

// Mostrar pantalla de login
function mostrarPantallaLogin() {
    const loginScreen = DOMCache.get('loginScreen');
    const appContainer = DOMCache.get('appContainer');
    
    if (loginScreen) loginScreen.classList.remove('login-hidden');
    if (appContainer) appContainer.classList.add('app-hidden');
    
    // Event listener para el formulario de login
    const loginForm = DOMCache.get('loginForm');
    if (loginForm) {
        loginForm.addEventListener('submit', (e) => {
            e.preventDefault();
            realizarLogin();
        });
    }
}

// Realizar login
async function realizarLogin() {
    const loginUsuario = DOMCache.get('loginUsuario');
    const loginContraseña = DOMCache.get('loginContraseña');
    const errorDiv = DOMCache.get('loginError');
    const loginForm = DOMCache.get('loginForm');

    if (!loginUsuario || !loginContraseña || !errorDiv) return;

    const usuario = loginUsuario.value.trim();
    const contraseña = loginContraseña.value;

    console.log('📝 Intentando login - Usuario:', usuario);

    try {
        // Asegurar usuarios cargados desde Google Sheets
        if ((!window.USUARIOS_SISTEMA || window.USUARIOS_SISTEMA.length === 0) && typeof cargarUsuariosDesdeAppScript === 'function') {
            try { await cargarUsuariosDesdeAppScript(); } catch (e) { console.warn('Fallo al sincronizar usuarios antes del login:', e); }
        }
        // Fallback: si sigue vacío, crear admin local temporal para no bloquear
        if (!window.USUARIOS_SISTEMA || window.USUARIOS_SISTEMA.length === 0) {
            window.USUARIOS_SISTEMA = [{
                id: 'usr_admin_local',
                usuario: 'admin',
                contraseña: 'c63bc483',
                rol: 'admin',
                centro: 'ADMINISTRACIÓN',
                activo: true,
                creado_en: new Date().toISOString()
            }];
            console.warn('Usando admin local de fallback para permitir acceso.');
        }

        // Autenticar solo con usuario y contraseña
        const usuarioAutenticado = auth.login(usuario, contraseña);
        
        console.log('Usuario autenticado:', usuarioAutenticado.usuario, 'Centro:', usuarioAutenticado.centro, 'Rol:', usuarioAutenticado.rol);

        // Limpiar formulario y ocultar error
        if (loginForm) loginForm.reset();
        errorDiv.classList.add('error-hidden');
        
        console.log('✓✓✓ Login exitoso para:', usuario, 'rol:', usuarioAutenticado.rol);
        
        // Mostrar aplicación
        mostrarAplicacion();
    } catch (error) {
        console.error('Error en login:', error);
        errorDiv.textContent = '❌ ' + error.message;
        errorDiv.classList.remove('error-hidden');
        if (loginContraseña) loginContraseña.value = '';
    }
}

// Abrir modal de confirmación de reseteo
function abrirModalResetConfirm() {
    const modal = document.getElementById('resetConfirmModal');
    const passwordInput = document.getElementById('resetPassword');
    const errorDiv = document.getElementById('resetError');
    
    if (modal) {
        modal.classList.remove('modal-hidden');
        if (passwordInput) passwordInput.value = '';
        if (errorDiv) errorDiv.classList.add('error-hidden');
    }
}

// Cerrar modal de confirmación de reseteo
function cerrarModalResetConfirm() {
    const modal = document.getElementById('resetConfirmModal');
    if (modal) {
        modal.classList.add('modal-hidden');
    }
}

// Confirmar reseteo con contraseña
async function confirmarReseteo(event) {
    event.preventDefault();
    
    const passwordInput = document.getElementById('resetPassword');
    const errorDiv = document.getElementById('resetError');
    const contraseña = passwordInput.value;
    
    // Obtener usuario y datos actuales
    const usuarioActual = auth.obtenerUsuarioActual && auth.obtenerUsuarioActual();
    
    if (!usuarioActual) {
        if (errorDiv) {
            errorDiv.textContent = '❌ No hay usuario autenticado';
            errorDiv.classList.remove('error-hidden');
        }
        return;
    }
    
    // Verificar contraseña (haciendo hash de la contraseña ingresada)
    const contraseñaHash = auth.hashearContraseña(contraseña);
    const contraseñaAlmacenada = usuarioActual.contraseña;
    
    console.log('🔐 Verificación de contraseña para reseteo:');
    console.log('  Contraseña hash ingresada:', contraseñaHash);
    console.log('  Contraseña almacenada:', contraseñaAlmacenada);
    console.log('  ¿Coinciden?:', contraseñaHash === contraseñaAlmacenada);
    
    if (contraseñaAlmacenada !== contraseñaHash) {
        if (errorDiv) {
            errorDiv.textContent = '❌ Contraseña incorrecta';
            errorDiv.classList.remove('error-hidden');
        }
        if (passwordInput) passwordInput.value = '';
        console.error('❌ Error: Contraseña incorrecta para reseteo');
        return;
    }
    
    // Contraseña correcta, proceder con reset
    if (errorDiv) errorDiv.classList.add('error-hidden');
    
    console.log('✓ Contraseña validada. Procediendo con reseteo...');
    
    // Primero limpiar Google Sheets, luego el sistema local
    try {
        console.log('📤 Enviando solicitud de limpieza a Google Sheets...');
        const urlLimpiar = APPS_SCRIPT_URL + '?action=deleteAllRecetas';
        const respuesta = await fetch(urlLimpiar, {
            method: 'GET',
            mode: 'no-cors'
        });
        
        console.log('✓ Solicitud GET enviada a Google Sheets');
        
        // Esperar un poco para asegurar que se procesó
        await new Promise(resolve => setTimeout(resolve, 1500));
    } catch (error) {
        console.warn('⚠️ Error enviando solicitud, pero continuando con reseteo local:', error);
    }
    
    // Ahora limpiar el sistema local
    auth.resetearSistema();
    cerrarModalResetConfirm();
    alert('✓ Sistema reseteado completamente. La página se recargará.');
    location.reload();
}

// Resetear sistema - abre modal de confirmación
function resetearYRecarga() {
    abrirModalResetConfirm();
}

// Mostrar aplicación principal
function mostrarAplicacion() {
    const loginScreen = DOMCache.get('loginScreen');
    const appContainer = DOMCache.get('appContainer');
    
    if (loginScreen) loginScreen.classList.add('login-hidden');
    if (appContainer) appContainer.classList.remove('app-hidden');
    
    // Actualizar información del usuario
    actualizarInfoUsuario();
    
    // Cargar datos filtrados para el nuevo usuario
    cargarDatos();
    
    // Aplicar permisos y deshabilitar campos para usuarios de centro
    aplicarPermisosEstablecimientos();
    
    // Mostrar/ocultar botón de admin
    const btnAdmin = DOMCache.get('btnAdmin');
    if (btnAdmin) {
        if (auth.esAdmin()) {
            btnAdmin.classList.remove('btn-hidden');
        } else {
            btnAdmin.classList.add('btn-hidden');
        }
    }
    
    // Mostrar/ocultar secciones solo para administrador
    const statsSection = DOMCache.get('stats-section-admin');
    const criticalSection = DOMCache.get('critical-section-admin');
    if (statsSection || criticalSection) {
        if (auth.esAdmin()) {
            if (statsSection) statsSection.style.display = 'block';
            if (criticalSection) criticalSection.style.display = 'block';
        } else {
            if (statsSection) statsSection.style.display = 'none';
            if (criticalSection) criticalSection.style.display = 'none';
        }
    }
    
    // Event listeners
    const btnLogout = DOMCache.get('btnLogout');
    if (btnLogout) {
        btnLogout.addEventListener('click', realizarLogout);
    }
    
    if (btnAdmin) {
        btnAdmin.addEventListener('click', abrirModalAdmin);
    }
    
    // Agregar event listeners para búsqueda de medicamentos
    const searchMedicamentos = DOMCache.get('search-medicamentos');
    if (searchMedicamentos) {
        searchMedicamentos.addEventListener('keyup', filtrarMedicamentosTable);
    }
    
    // Agregar event listeners para autocomplete de productos
    if (DOMCache.producto) {
        DOMCache.producto.addEventListener('keyup', filtrarProductos);
    }
    
    // Agregar event listeners para autocomplete de tipos de servicio
    if (DOMCache.tipoServicio) {
        DOMCache.tipoServicio.addEventListener('keyup', filtrarTiposServicio);
        DOMCache.tipoServicio.addEventListener('focus', () => {
            console.log('Campo tipo de servicio enfocado. Catálogo tiene', CATALOGO_TIPOS_SERVICIO.length, 'elementos');
            // Mostrar todos los tipos cuando se enfoca el campo (si está vacío)
            if (CATALOGO_TIPOS_SERVICIO.length > 0) {
                if (DOMCache.tipoServicio.value.length === 0) {
                    mostrarTodosTiposServicio();
                } else {
                    // Si ya tiene texto, filtrar
                    filtrarTiposServicio();
                }
            } else {
                console.warn('Catálogo de tipos de servicio vacío al enfocar');
            }
        });
        DOMCache.tipoServicio.addEventListener('click', () => {
            // También mostrar lista al hacer click
            if (CATALOGO_TIPOS_SERVICIO.length > 0 && DOMCache.tipoServicio.value.length === 0) {
                mostrarTodosTiposServicio();
            }
        });
    } else {
        console.error('No se encontró el elemento tipo_servicio en DOMCache');
    }
    
    // Cerrar sugerencias de tipos de servicio al hacer click fuera
    document.addEventListener('click', function(event) {
        const sugerenciasDiv = DOMCache.sugerenciasTipoServicio;
        const inputTipoServicio = DOMCache.tipoServicio;
        
        if (sugerenciasDiv && inputTipoServicio && 
            !event.target.closest('.autocomplete-wrapper') &&
            !event.target.closest('#sugerenciasTipoServicio')) {
            sugerenciasDiv.classList.remove('active');
        }
    });
    
    // Agregar event listeners para autocomplete de establecimientos en admin
    const newCentro = DOMCache.get('newCentro');
    if (newCentro) {
        newCentro.addEventListener('keyup', filtrarEstablecimientosAdmin);
    }
    
    const editCentro = DOMCache.get('editCentro');
    if (editCentro) {
        editCentro.addEventListener('keyup', filtrarEstablecimientosEditarAdmin);
    }

    // Inicializar estado de inputs admin: deshabilitar hasta que se seleccione una RED
    const newRed = DOMCache.get('newRed');
    const editRed = DOMCache.get('editRed');
    if (newRed) {
        newRed.addEventListener('change', () => actualizarEstablecimientosAdmin('new'));
        if (!newRed.value) {
            if (newCentro) newCentro.disabled = true;
        }
    }
    if (editRed) {
        editRed.addEventListener('change', () => actualizarEstablecimientosAdmin('edit'));
        if (!editRed.value) {
            if (editCentro) editCentro.disabled = true;
        }
    }
}

// Actualizar información del usuario en navbar
function actualizarInfoUsuario() {
    const userInfo = DOMCache.get('userInfo');
    const usuario = auth.obtenerUsuarioActual();
    
    if (userInfo && usuario) {
        const rol = usuario.rol === 'admin' ? '👤 Administrador' : '🏥 Usuario de Centro';
        const centro = usuario.rol === 'admin' ? 'Sistema' : usuario.centro;
        userInfo.textContent = `${usuario.usuario} (${rol}) - ${centro}`;
    }
}

// Realizar logout
function realizarLogout() {
    if (confirm('¿Deseas cerrar sesión?')) {
        auth.logout();
        document.getElementById('loginForm').reset();
        mostrarPantallaLogin();
    }
}

// Abrir modal de gestión de usuarios (admin)
function abrirModalAdmin() {
    if (!auth.esAdmin()) {
        mostrarNotificacion('Solo administradores pueden acceder a esta función', 'warning');
        return;
    }
    
    const adminModal = DOMCache.get('adminModal');
    if (adminModal) {
        adminModal.classList.remove('modal-hidden');
        cargarListaUsuarios();
        
        // Cargar catálogos para el formulario de crear usuario
        cargarCatalogo();
        
        // Esperar un poco y luego preparar los selects del formulario
        setTimeout(() => {
            prepararSelectoresAdmin();
        }, 100);
    }
}

// Preparar selectores del modal de admin
function prepararSelectoresAdmin() {
    const newRed = document.getElementById('newRed');
    const editRed = document.getElementById('editRed');
    
    // Llenar select de RED para crear usuario
    if (newRed && CATALOGO_ESTABLECIMIENTOS && CATALOGO_ESTABLECIMIENTOS.redes) {
        // Limpiar opciones previas (menos la primera)
        while (newRed.options.length > 1) newRed.remove(1);
        
        // Agregar redes
        CATALOGO_ESTABLECIMIENTOS.redes.forEach(red => {
            const opt = document.createElement('option');
            opt.value = red.nombre;
            opt.textContent = red.nombre;
            newRed.appendChild(opt);
        });
        
        // Remover eventos previos y agregar nuevo
        const newRedClone = newRed.cloneNode(true);
        newRed.parentNode.replaceChild(newRedClone, newRed);
        document.getElementById('newRed').addEventListener('change', () => actualizarEstablecimientosAdmin('new'));
    }
    
    // Llenar select de RED para editar usuario
    if (editRed && CATALOGO_ESTABLECIMIENTOS && CATALOGO_ESTABLECIMIENTOS.redes) {
        while (editRed.options.length > 1) editRed.remove(1);
        
        CATALOGO_ESTABLECIMIENTOS.redes.forEach(red => {
            const opt = document.createElement('option');
            opt.value = red.nombre;
            opt.textContent = red.nombre;
            editRed.appendChild(opt);
        });
        
        const editRedClone = editRed.cloneNode(true);
        editRed.parentNode.replaceChild(editRedClone, editRed);
        document.getElementById('editRed').addEventListener('change', () => actualizarEstablecimientosAdmin('edit'));
    }
}

// Cerrar modal de admin
function cerrarModalAdmin() {
    const adminModal = DOMCache.get('adminModal');
    if (adminModal) {
        adminModal.classList.add('modal-hidden');
    }
}

// Cambiar tab en modal de admin
function cambiarTab(tabName) {
    // Ocultar todos los tabs
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.add('tab-hidden');
        tab.classList.remove('active');
    });
    
    // Desactivar todos los botones
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    // Mostrar tab seleccionado
    const tab = DOMCache.get(`tab${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`);
    if (tab) {
        tab.classList.remove('tab-hidden');
        tab.classList.add('active');
    }
    
    // Activar botón correspondiente si existe
    const activeBtn = event?.target;
    if (activeBtn && activeBtn.classList.contains('tab-btn')) {
        activeBtn.classList.add('active');
    }
}

// Agregar event listeners del formulario de admin
function agregarEventListenersAdmin() {
    const formCrear = document.getElementById('formCrearUsuario');
    if (formCrear) {
        formCrear.addEventListener('submit', (e) => {
            e.preventDefault();
            crearNuevoUsuario();
        });
    }
    
    // Cerrar modal con ESC
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const adminModal = DOMCache.get('adminModal');
            if (adminModal && !adminModal.classList.contains('modal-hidden')) {
                cerrarModalAdmin();
            }
        }
    });
    
    // Cerrar modal al hacer click fuera
    const adminModal = DOMCache.get('adminModal');
    if (adminModal) {
        adminModal.addEventListener('click', (e) => {
            if (e.target === adminModal) {
                cerrarModalAdmin();
            }
        });
    }
    
    // Cerrar sugerencias de establecimientos al hacer click fuera
    document.addEventListener('click', function(event) {
        const sugerenciasDiv = document.getElementById('sugerenciasEstablecimientos');
        const inputCentro = document.getElementById('newCentro');
        
        if (sugerenciasDiv && inputCentro && !event.target.closest('#newCentro') && !event.target.closest('#sugerenciasEstablecimientos')) {
            sugerenciasDiv.classList.remove('active');
        }
    });

    // Autocomplete: mostrar sugerencias al enfocar los inputs de centro
    const newCentro = document.getElementById('newCentro');
    if (newCentro) {
        newCentro.addEventListener('keyup', filtrarEstablecimientosAdmin);
        newCentro.addEventListener('focus', mostrarTodosEstablecimientosAdmin);
    }

    const editCentro = document.getElementById('editCentro');
    if (editCentro) {
        editCentro.addEventListener('keyup', filtrarEstablecimientosEditarAdmin);
        editCentro.addEventListener('focus', mostrarTodosEstablecimientosEditar);
    }
}

// Crear nuevo usuario
function crearNuevoUsuario() {
    const usuario = DOMCache.get('newUsuario')?.value.trim() || '';
    const contraseña = DOMCache.get('newContraseña')?.value || '';
    const rol = DOMCache.get('newRol')?.value || '';
    const centro = DOMCache.get('newCentro')?.value.trim() || '';
    
    const errorDiv = DOMCache.get('crearError');
    const successDiv = DOMCache.get('crearSuccess');
    
    if (!errorDiv || !successDiv) {
        console.error('No se encontraron los elementos de mensaje');
        alert('Error: No se encontraron los elementos del formulario');
        return;
    }
    
    // Limpiar mensajes previos
    errorDiv.classList.add('error-hidden');
    successDiv.classList.add('success-hidden');

    // Validaciones básicas
    if (!usuario) {
        errorDiv.textContent = '❌ Debes ingresar un nombre de usuario';
        errorDiv.classList.remove('error-hidden');
        return;
    }

    if (!contraseña) {
        errorDiv.textContent = '❌ Debes ingresar una contraseña';
        errorDiv.classList.remove('error-hidden');
        return;
    }

    if (contraseña.length < 6) {
        errorDiv.textContent = '❌ La contraseña debe tener mínimo 6 caracteres';
        errorDiv.classList.remove('error-hidden');
        return;
    }

    if (!rol) {
        errorDiv.textContent = '❌ Debes seleccionar un rol';
        errorDiv.classList.remove('error-hidden');
        return;
    }

    if (!centro) {
        errorDiv.textContent = '❌ Debes seleccionar o ingresar un centro';
        errorDiv.classList.remove('error-hidden');
        return;
    }

    try {
        console.log('Intentando crear usuario:', { usuario, rol, centro });
        
        // Crear usuario
        const nuevoUsuario = auth.crearUsuario(usuario, contraseña, rol, centro);
        
        console.log('Usuario creado exitosamente:', nuevoUsuario);
        
        // Mostrar éxito
        successDiv.textContent = `✓ Usuario "${usuario}" creado exitosamente`;
        successDiv.classList.remove('success-hidden');
        
        // Limpiar formulario
        const formCrearUsuario = DOMCache.get('formCrearUsuario');
        if (formCrearUsuario) {
            formCrearUsuario.reset();
        }
        
        // Recargar lista
        setTimeout(() => {
            cargarListaUsuarios();
            successDiv.classList.add('success-hidden');
        }, 2000);
        
    } catch (error) {
        console.error('Error al crear usuario:', error);
        errorDiv.textContent = '❌ ' + error.message;
        errorDiv.classList.remove('error-hidden');
    }
}

// Obtener todos los establecimientos del catálogo
function obtenerTodosLosEstablecimientos() {
    const establecimientos = [];
    
    if (CATALOGO_ESTABLECIMIENTOS.redes && CATALOGO_ESTABLECIMIENTOS.redes.length > 0) {
        CATALOGO_ESTABLECIMIENTOS.redes.forEach(red => {
            if (red.establecimientos && Array.isArray(red.establecimientos)) {
                establecimientos.push(...red.establecimientos);
            }
        });
    }
    
    return establecimientos.sort();
}

function obtenerEstablecimientosPorRedConCod(redNombre) {
    const salida = [];

    if (Array.isArray(CATALOGO_ESTABLECIMIENTOS.datos_raw) && CATALOGO_ESTABLECIMIENTOS.datos_raw.length > 0) {
        const redes = redNombre
            ? CATALOGO_ESTABLECIMIENTOS.datos_raw.filter(r => r && r.nombre === redNombre)
            : CATALOGO_ESTABLECIMIENTOS.datos_raw;

        redes.forEach(red => {
            if (red && Array.isArray(red.establecimientos)) {
                red.establecimientos.forEach(est => {
                    const nombre = typeof est === 'string' ? est : (est?.nombre || '');
                    const cod_pre = typeof est === 'string' ? '' : (est?.cod_pre || '');
                    if (nombre) salida.push({ nombre, cod_pre: cod_pre ? String(cod_pre).trim() : '' });
                });
            }
        });
    }

    if (salida.length === 0) {
        const lista = redNombre
            ? (CATALOGO_ESTABLECIMIENTOS.redes.find(r => r.nombre === redNombre)?.establecimientos || [])
            : obtenerTodosLosEstablecimientos();

        lista.forEach(nombre => {
            if (nombre) salida.push({ nombre, cod_pre: '' });
        });
    }

    const vistos = new Set();
    const unicos = [];
    salida.forEach(item => {
        const key = (item.nombre || '').toUpperCase().trim();
        if (key && !vistos.has(key)) {
            vistos.add(key);
            unicos.push(item);
        }
    });

    return unicos.sort((a, b) => a.nombre.localeCompare(b.nombre));
}

// Renderizar lista visible de establecimientos en un contenedor
function renderListaEstablecimientos(redNombre, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    let lista = [];
    if (redNombre) {
        const redObj = CATALOGO_ESTABLECIMIENTOS.redes.find(r => r.nombre === redNombre);
        lista = redObj && Array.isArray(redObj.establecimientos) ? redObj.establecimientos : [];
    } else {
        lista = obtenerTodosLosEstablecimientos();
    }

    if (!lista || lista.length === 0) {
        container.innerHTML = '<div style="color:#666;">No hay establecimientos para mostrar.</div>';
        return;
    }

    // Construir lista UL
    const items = lista.map(est => `
        <li style="padding:6px 8px; border-bottom:1px solid #f1f1f1; cursor:pointer; list-style:none;">
            <span onclick="handleClickListaEstablecimiento(event, '${est.replace(/'/g, "\\'")}', '${containerId}')" style="display:inline-block; width:100%;">🏥 ${est}</span>
        </li>
    `).join('');

    container.innerHTML = `<ul style="margin:0; padding:0;">${items}</ul>`;
}

// Manejar clicks en la lista visible para asignar al input correcto
function handleClickListaEstablecimiento(event, establecimiento, containerId) {
    // Determinar contexto por containerId
    if (containerId === 'listaEstablecimientosMain') {
        seleccionarEstablecimientoMain(establecimiento);
    } else if (containerId === 'listaEstablecimientosAdmin') {
        seleccionarEstablecimiento(establecimiento);
    } else if (containerId === 'listaEstablecimientosEditarBox') {
        seleccionarEstablecimientoEditar(establecimiento);
    }
}

// Filtrar y mostrar sugerencias de establecimientos en el formulario de crear usuario
function filtrarEstablecimientosAdmin() {
    const inputCentro = document.getElementById('newCentro');
    if (!inputCentro) return;
    const busqueda = inputCentro.value.toLowerCase().trim();
    const sugerenciasDiv = document.getElementById('sugerenciasEstablecimientos');
    const datalist = document.getElementById('establecimientosList');

    if (busqueda.length < 1) {
        sugerenciasDiv.innerHTML = '';
        sugerenciasDiv.classList.remove('active');
        datalist.innerHTML = '';
        return;
    }

    // Obtener establecimientos según la red seleccionada en el formulario de creación
    const selectedRed = document.getElementById('newRed') ? document.getElementById('newRed').value : '';
    const todosEstablecimientos = obtenerEstablecimientosPorRedConCod(selectedRed || null);

    // Filtrar por nombre o COD PRE
    const resultados = todosEstablecimientos.filter(est => {
        const nombre = (est.nombre || '').toLowerCase();
        const codigo = (est.cod_pre || '').toLowerCase();
        return nombre.includes(busqueda) || codigo.includes(busqueda);
    }).slice(0, 20);

    if (resultados.length === 0) {
        sugerenciasDiv.innerHTML = '<div class="sugerencia-item" style="color: #999;">No se encontraron establecimientos</div>';
        sugerenciasDiv.classList.add('active');
        datalist.innerHTML = '';
        return;
    }

    // Mostrar sugerencias visibles
    sugerenciasDiv.innerHTML = resultados.map(est => `
        <div class="sugerencia-item" onclick="seleccionarEstablecimiento('${est.nombre.replace(/'/g, "\\'")}')">
            <div class="sugerencia-descripcion">🏥 ${est.cod_pre ? `[${est.cod_pre}] ` : ''}${est.nombre}</div>
        </div>
    `).join('');
    sugerenciasDiv.classList.add('active');

    // Llenar datalist para navegación con teclado
    datalist.innerHTML = resultados.map(est => `
        <option value="${est.nombre}"></option>
    `).join('');
}

// Mostrar todos los establecimientos en el formulario de crear usuario (al enfocar)
function mostrarTodosEstablecimientosAdmin() {
    const inputCentro = document.getElementById('newCentro');
    const sugerenciasDiv = document.getElementById('sugerenciasEstablecimientos');
    const datalist = document.getElementById('establecimientosList');

    if (!inputCentro || !sugerenciasDiv || !datalist) return;

    const selectedRed = document.getElementById('newRed') ? document.getElementById('newRed').value : '';
    const lista = obtenerEstablecimientosPorRedConCod(selectedRed || null);

    if (!lista || lista.length === 0) {
        sugerenciasDiv.innerHTML = '<div class="sugerencia-item" style="color:#999;">No hay establecimientos disponibles</div>';
        sugerenciasDiv.classList.add('active');
        datalist.innerHTML = '';
        return;
    }

    // Mostrar hasta 50 sugerencias
    const toShow = lista.slice(0, 50);
    sugerenciasDiv.innerHTML = toShow.map(est => `
        <div class="sugerencia-item" onclick="seleccionarEstablecimiento('${est.nombre.replace(/'/g, "\\'")}')">
            <div class="sugerencia-descripcion">🏥 ${est.cod_pre ? `[${est.cod_pre}] ` : ''}${est.nombre}</div>
        </div>
    `).join('');
    sugerenciasDiv.classList.add('active');

    // Llenar datalist para navegación con teclado
    datalist.innerHTML = toShow.map(est => `<option value="${est.nombre}"></option>`).join('');
}

// Seleccionar un establecimiento de las sugerencias
function seleccionarEstablecimiento(establecimiento) {
    document.getElementById('newCentro').value = establecimiento;
    document.getElementById('sugerenciasEstablecimientos').classList.remove('active');
    document.getElementById('sugerenciasEstablecimientos').innerHTML = '';
    document.getElementById('establecimientosList').innerHTML = '';
}

// Actualizar datalist y estado cuando se selecciona una RED en admin (crear/editar)
function actualizarEstablecimientosAdmin(mode) {
    // mode: 'new' or 'edit'
    const redSelect = document.getElementById(mode === 'edit' ? 'editRed' : 'newRed');
    const inputCentro = document.getElementById(mode === 'edit' ? 'editCentro' : 'newCentro');
    const datalistId = mode === 'edit' ? 'establecimientosListEditar' : 'establecimientosList';
    const datalist = document.getElementById(datalistId);
    const sugerenciasId = mode === 'edit' ? 'sugerenciasEstablecimientosEditar' : 'sugerenciasEstablecimientos';
    const sugerenciasDiv = document.getElementById(sugerenciasId);

    if (!redSelect) return;

    const selectedRed = redSelect.value;
    let lista = [];
    if (selectedRed) {
        const redObj = CATALOGO_ESTABLECIMIENTOS.redes.find(r => r.nombre === selectedRed);
        lista = redObj && Array.isArray(redObj.establecimientos) ? redObj.establecimientos : [];
    } else {
        lista = obtenerTodosLosEstablecimientos();
    }

    // Poblar datalist
    if (datalist) {
        datalist.innerHTML = lista.map(est => `<option value="${est}"></option>`).join('');
    }

    // Reset input and sugerencias
    if (inputCentro) {
        inputCentro.value = '';
        inputCentro.disabled = !selectedRed ? true : false;
        inputCentro.placeholder = selectedRed ? 'Escribe para buscar dentro de la red seleccionada' : 'Selecciona primero una RED';
    }

    if (sugerenciasDiv) {
        sugerenciasDiv.innerHTML = '';
        sugerenciasDiv.classList.remove('active');
    }
    // Renderizar lista visible para este modo
    const containerId = mode === 'edit' ? 'listaEstablecimientosEditarBox' : 'listaEstablecimientosAdmin';
    try { renderListaEstablecimientos(selectedRed || null, containerId); } catch (e) {}
}

// Cargar lista de usuarios
function cargarListaUsuarios() {
    const tbody = document.getElementById('usuariosTableBody');
    if (!tbody) return;
    
    const usuarios = auth.obtenerTodosLosUsuarios();
    
    if (usuarios.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;">No hay usuarios</td></tr>';
        return;
    }
    
    tbody.innerHTML = usuarios.map(usuario => {
        const fecha = new Date(usuario.creado_en).toLocaleDateString('es-ES');
        const rolBadge = usuario.rol === 'admin' 
            ? '<span style="background:#dc3545;color:white;padding:3px 8px;border-radius:3px;font-size:0.9em;">👤 Admin</span>'
            : '<span style="background:#28a745;color:white;padding:3px 8px;border-radius:3px;font-size:0.9em;">🏥 Usuario</span>';
        
        return `
            <tr>
                <td><strong>${usuario.usuario}</strong></td>
                <td>${rolBadge}</td>
                <td>${usuario.centro}</td>
                <td>${fecha}</td>
                <td>
                    <button class="btn btn-primary btn-small" onclick="abrirEdicionUsuario('${usuario.id}', '${usuario.usuario}')">✏️ Editar</button>
                    <button class="btn btn-danger btn-small" onclick="eliminarUsuarioConfirm('${usuario.id}', '${usuario.usuario}')">🗑️ Eliminar</button>
                </td>
            </tr>
        `;
    }).join('');
}

// Abrir modal para editar usuario
function abrirEdicionUsuario(usuarioId, nombreUsuario) {
    const usuario = auth.obtenerTodosLosUsuarios().find(u => u.id === usuarioId);
    if (!usuario) {
        mostrarNotificacion('Usuario no encontrado', 'warning');
        return;
    }

    // Llenar el formulario de edición
    const editUsuarioActual = DOMCache.get('editUsuarioActual');
    const editNuevoUsuario = DOMCache.get('editNuevoUsuario');
    const editNuevaContraseña = DOMCache.get('editNuevaContraseña');
    const editRol = DOMCache.get('editRol');
    const editCentro = DOMCache.get('editCentro');
    const editarError = DOMCache.get('editarError');
    const editarSuccess = DOMCache.get('editarSuccess');
    const tabEditarBtn = DOMCache.get('tabEditarBtn');
    
    if (editUsuarioActual) editUsuarioActual.value = usuario.usuario;
    if (editNuevoUsuario) editNuevoUsuario.value = '';
    if (editNuevaContraseña) editNuevaContraseña.value = '';
    if (editRol) editRol.value = usuario.rol;
    if (editCentro) editCentro.value = usuario.centro;
    
    // Guardar el ID del usuario siendo editado
    window.usuarioEditandoId = usuarioId;
    window.usuarioEditandoNombre = usuario.usuario;
    
    // Limpiar mensajes
    if (editarError) editarError.classList.add('error-hidden');
    if (editarSuccess) editarSuccess.classList.add('success-hidden');
    
    // Mostrar pestaña de edición
    if (tabEditarBtn) {
        tabEditarBtn.classList.remove('tab-btn-hidden');
    }
    cambiarTab('editar');
}

// Cancelar edición de usuario
function cancelarEdicionUsuario() {
    window.usuarioEditandoId = null;
    window.usuarioEditandoNombre = null;
    const tabEditarBtn = DOMCache.get('tabEditarBtn');
    if (tabEditarBtn) {
        tabEditarBtn.classList.add('tab-btn-hidden');
    }
    cambiarTab('listar');
}

// Guardar cambios del usuario
document.addEventListener('DOMContentLoaded', () => {
    const formEditarUsuario = document.getElementById('formEditarUsuario');
    if (formEditarUsuario) {
        formEditarUsuario.addEventListener('submit', (e) => {
            e.preventDefault();
            guardarEdicionUsuario();
        });
    }
});

function guardarEdicionUsuario() {
    const usuarioId = window.usuarioEditandoId;
    if (!usuarioId) {
        mostrarNotificacion('No hay usuario seleccionado', 'warning');
        return;
    }

    const nuevoUsuario = DOMCache.get('editNuevoUsuario')?.value.trim() || '';
    const nuevaContraseña = DOMCache.get('editNuevaContraseña')?.value || '';
    const rol = DOMCache.get('editRol')?.value || '';
    const centro = DOMCache.get('editCentro')?.value.trim() || '';
    const errorDiv = DOMCache.get('editarError');
    const successDiv = DOMCache.get('editarSuccess');

    if (!errorDiv || !successDiv) return;

    if (!rol) {
        errorDiv.textContent = '❌ Debes seleccionar un rol';
        errorDiv.classList.remove('error-hidden');
        return;
    }

    if (rol === 'usuario' && !centro) {
        errorDiv.textContent = '❌ Debes seleccionar un centro';
        errorDiv.classList.remove('error-hidden');
        return;
    }

    try {
        const actualizaciones = {
            rol: rol,
            centro: centro
        };

        if (nuevoUsuario) {
            actualizaciones.usuario = nuevoUsuario;
        }

        if (nuevaContraseña) {
            if (nuevaContraseña.length < 6) {
                throw new Error('La contraseña debe tener mínimo 6 caracteres');
            }
            actualizaciones.contraseña = nuevaContraseña;
        }

        auth.actualizarUsuario(usuarioId, actualizaciones);

        successDiv.textContent = '✓ Usuario actualizado exitosamente';
        successDiv.classList.remove('success-hidden');
        errorDiv.classList.add('error-hidden');

        setTimeout(() => {
            cancelarEdicionUsuario();
            cargarListaUsuarios();
        }, 1500);

    } catch (error) {
        console.error('Error al actualizar usuario:', error);
        errorDiv.textContent = '❌ ' + error.message;
        errorDiv.classList.remove('error-hidden');
        successDiv.classList.add('success-hidden');
    }
}

// Eliminar usuario desde la pestaña de edición
function eliminarUsuarioActual() {
    const usuarioId = window.usuarioEditandoId;
    const nombreUsuario = window.usuarioEditandoNombre;
    
    if (!usuarioId || !nombreUsuario) {
        alert('No hay usuario seleccionado');
        return;
    }

    eliminarUsuarioConfirm(usuarioId, nombreUsuario);
}

// Eliminar usuario con confirmación
function eliminarUsuarioConfirm(usuarioId, nombreUsuario) {
    if (confirm(`¿Eliminar el usuario "${nombreUsuario}"? Esta acción no se puede deshacer.`)) {
        try {
            auth.eliminarUsuario(usuarioId);
            mostrarNotificacion(`Usuario "${nombreUsuario}" eliminado`, 'warning');
            cancelarEdicionUsuario();
            cargarListaUsuarios();
        } catch (error) {
            alert('Error al eliminar: ' + error.message);
        }
    }
}

// Filtrar establecimientos para edición de usuario
function filtrarEstablecimientosEditarAdmin() {
    const inputCentro = document.getElementById('editCentro');
    const sugerencias = document.getElementById('sugerenciasEstablecimientosEditar');
    
    if (!inputCentro || !sugerencias) return;
    
    const valor = inputCentro.value.toLowerCase().trim();
    const selectedRed = document.getElementById('editRed') ? document.getElementById('editRed').value : '';
    const todosEstablecimientos = obtenerEstablecimientosPorRedConCod(selectedRed || null);
    
    if (valor.length === 0) {
        sugerencias.innerHTML = '';
        sugerencias.style.display = 'none';
        return;
    }
    
    const filtrados = todosEstablecimientos.filter(est => {
        const nombre = (est.nombre || '').toLowerCase();
        const codigo = (est.cod_pre || '').toLowerCase();
        return nombre.includes(valor) || codigo.includes(valor);
    }
    );
    
    if (filtrados.length === 0) {
        sugerencias.innerHTML = '<div class="sugerencia-item no-resultado">No se encontraron establecimientos</div>';
        sugerencias.style.display = 'block';
        return;
    }
    
    sugerencias.innerHTML = filtrados.slice(0, 8).map(est => 
        `<div class="sugerencia-item" onclick="seleccionarEstablecimientoEditar('${est.nombre.replace(/'/g, "\\'")}')" style="cursor: pointer;">
            <span style="color: #28a745;">🏥</span> ${est.cod_pre ? `[${est.cod_pre}] ` : ''}${est.nombre}
        </div>`
    ).join('');
    
    sugerencias.style.display = 'block';
}

// Mostrar todos los establecimientos en el formulario de editar usuario (al enfocar)
function mostrarTodosEstablecimientosEditar() {
    const inputCentro = document.getElementById('editCentro');
    const sugerencias = document.getElementById('sugerenciasEstablecimientosEditar');
    const datalist = document.getElementById('establecimientosListEditar');

    if (!inputCentro || !sugerencias || !datalist) return;

    const selectedRed = document.getElementById('editRed') ? document.getElementById('editRed').value : '';
    const lista = obtenerEstablecimientosPorRedConCod(selectedRed || null);

    if (!lista || lista.length === 0) {
        sugerencias.innerHTML = '<div class="sugerencia-item" style="color:#999;">No hay establecimientos disponibles</div>';
        sugerencias.style.display = 'block';
        datalist.innerHTML = '';
        return;
    }

    const toShow = lista.slice(0, 50);
    sugerencias.innerHTML = toShow.map(est => `
        <div class="sugerencia-item" onclick="seleccionarEstablecimientoEditar('${est.nombre.replace(/'/g, "\\'")}')" style="cursor: pointer;">
            <span style="color: #28a745;">🏥</span> ${est.cod_pre ? `[${est.cod_pre}] ` : ''}${est.nombre}
        </div>
    `).join('');
    sugerencias.style.display = 'block';
    datalist.innerHTML = toShow.map(est => `<option value="${est.nombre}"></option>`).join('');
}

// Seleccionar establecimiento para edición
function seleccionarEstablecimientoEditar(establecimiento) {
    const inputCentro = document.getElementById('editCentro');
    const sugerencias = document.getElementById('sugerenciasEstablecimientosEditar');
    
    inputCentro.value = establecimiento;
    sugerencias.innerHTML = '';
    sugerencias.style.display = 'none';
}

// Filtrar datos según permisos
function obtenerDatosConPermisos() {
    let datos = obtenerDatos();
    
    // Si es admin, devuelve todos los datos
    if (auth.esAdmin()) {
        return datos;
    }
    
    // Si es usuario de centro, solo devuelve datos de su centro
    const centroUsuario = auth.obtenerCentroActual();
    return datos.filter(registro => registro.establecimiento === centroUsuario);
}

// Modificar cargarDatos para usar permisos
const cargarDatosOriginal = cargarDatos;


// Mostrar resumen general (solo admin)
function mostrarResumenGeneral() {
    const todosLosDatos = obtenerDatos();
    
    // Contar por centro
    const datosPorCentro = {};
    todosLosDatos.forEach(registro => {
        if (!datosPorCentro[registro.establecimiento]) {
            datosPorCentro[registro.establecimiento] = 0;
        }
        datosPorCentro[registro.establecimiento] += 1;
    });
    
    console.log('Resumen General (Admin):', datosPorCentro);
}

// Mostrar solo establecimientos del usuario actual en dropdown
function actualizarSelectosSegunPermiso() {
    if (auth.esAdmin()) {
        // Admin ve todos los establecimientos
        cargarCatalogo();
    } else {
        // Usuario solo ve su centro
        const centroUsuario = auth.obtenerCentroActual();
        const selectRed = document.getElementById('red');
        const selectEst = document.getElementById('establecimiento');
        
        if (selectRed && selectEst) {
            // Pre-seleccionar el centro del usuario
            selectEst.innerHTML = `<option value="${centroUsuario}" selected>${centroUsuario}</option>`;
            selectRed.disabled = true;
            selectEst.disabled = true;
            
            document.querySelector('.form-section').style.opacity = '0.9';
        }
    }
}
