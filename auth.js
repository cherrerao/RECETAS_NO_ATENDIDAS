// Sistema de Autenticación y Autorización
// Almacenamiento de usuarios, sesiones y permisos

const AUTH_STORAGE_KEY = 'recetas_auth_users';
const SESSION_KEY = 'recetas_sesion_actual';

// Estructura de un usuario: { id, usuario, contraseña (hash), rol, centro, creado_en }
// Roles: 'admin', 'usuario'

class AutenticacionSistema {
    constructor() {
        this.usuarioActual = null;
        this.cargarSesion();
    }

    // Cargar sesión actual si existe
    cargarSesion() {
        const sesion = localStorage.getItem(SESSION_KEY);
        if (sesion) {
            try {
                this.usuarioActual = JSON.parse(sesion);
            } catch (e) {
                console.error('Error al cargar sesión:', e);
                this.logout();
            }
        }
    }

    // Verificar si hay usuario logueado
    estaAutenticado() {
        return this.usuarioActual !== null;
    }

    // Obtener usuario actual
    obtenerUsuarioActual() {
        return this.usuarioActual;
    }

    // Obtener rol actual
    obtenerRolActual() {
        return this.usuarioActual?.rol || null;
    }

    // Obtener centro actual
    obtenerCentroActual() {
        return this.usuarioActual?.centro || null;
    }

    // Verificar si es administrador
    esAdmin() {
        return this.usuarioActual?.rol === 'admin';
    }

    // Hash simple para contraseña
    hashearContraseña(contraseña) {
        // Usar una función hash simple pero consistente
        let hash = 0;
        if (contraseña.length === 0) return '0';
        for (let i = 0; i < contraseña.length; i++) {
            const char = contraseña.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
        }
        return hash.toString(16);
    }

    // Obtener todos los usuarios (SIEMPRE devuelve los usuarios)
    obtenerTodosLosUsuarios() {
        const usuarios = localStorage.getItem(AUTH_STORAGE_KEY);
        return usuarios ? JSON.parse(usuarios) : [];
    }
    
    // Obtener todos los usuarios (solo si es admin)
    obtenerTodosLosUsuariosAdmin() {
        if (!this.esAdmin()) {
            console.error('Solo administradores pueden obtener la lista de usuarios');
            return [];
        }
        return this.obtenerTodosLosUsuarios();
    }

    // Crear usuario (solo admin puede crear)
    crearUsuario(usuario, contraseña, rol, centro) {
        if (!this.esAdmin()) {
            throw new Error('Solo administradores pueden crear usuarios');
        }

        // Validación básica
        if (!usuario || !contraseña || !rol || !centro) {
            throw new Error('Todos los campos son requeridos');
        }

        // Validar que sea un usuario válido por centro (máximo uno por centro)
        const usuarios = this.obtenerTodosLosUsuarios();
        const usuarioExistente = usuarios.find(u => u.usuario === usuario);
        
        if (usuarioExistente) {
            throw new Error('El usuario ya existe');
        }

        // Verificar que no exista otro usuario (no admin) para este centro
        if (rol === 'usuario') {
            const usuarioCentro = usuarios.find(u => u.centro === centro && u.rol === 'usuario');
            if (usuarioCentro) {
                throw new Error(`Ya existe un usuario para el centro "${centro}". Solo se permite un usuario por centro.`);
            }
        }

        // Crear nuevo usuario
        const nuevoUsuario = {
            id: 'usr_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
            usuario: usuario.trim(),
            contraseña: this.hashearContraseña(contraseña),
            rol: rol,
            centro: centro,
            creado_en: new Date().toISOString(),
            activo: true
        };

        usuarios.push(nuevoUsuario);
        localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(usuarios));

        // Log de auditoría
        console.log(`[AUDITORÍA] Usuario ${this.usuarioActual.usuario} creó usuario: ${usuario} (${rol})`);

        return nuevoUsuario;
    }

    // Login
    login(usuario, contraseña) {
        const usuarios = this.obtenerTodosLosUsuarios();
        console.log('📝 INTENTO DE LOGIN');
        console.log('  Usuario ingresado:', usuario);
        console.log('  Contraseña ingresada:', contraseña);
        console.log('  Total usuarios en BD:', usuarios.length);
        
        // Calcular hash de la contraseña ingresada
        const contraseñaHash = this.hashearContraseña(contraseña);
        console.log('  Hash generado:', contraseñaHash);
        
        // Mostrar todos los usuarios
        usuarios.forEach((u, idx) => {
            console.log(`  [${idx}] ${u.usuario} - rol: ${u.rol} - activo: ${u.activo} - hash: ${u.contraseña}`);
        });
        
        // Buscar usuario
        const usuarioEncontrado = usuarios.find(u => {
            const usuarioCoincide = u.usuario === usuario;
            const contraseñaCoincide = u.contraseña === contraseñaHash;
            const estaActivo = u.activo === true;
            
            console.log(`  Comparando "${usuario}": usuario=${usuarioCoincide}, contraseña=${contraseñaCoincide}, activo=${estaActivo}`);
            
            return usuarioCoincide && contraseñaCoincide && estaActivo;
        });

        if (!usuarioEncontrado) {
            console.error('  ❌ Usuario no encontrado o contraseña incorrecta');
            throw new Error('Usuario o contraseña incorrectos');
        }

        // Crear sesión
        console.log('  ✓ Usuario autenticado exitosamente');
        this.usuarioActual = {
            id: usuarioEncontrado.id,
            usuario: usuarioEncontrado.usuario,
            rol: usuarioEncontrado.rol,
            centro: usuarioEncontrado.centro,
            login_en: new Date().toISOString()
        };

        localStorage.setItem(SESSION_KEY, JSON.stringify(this.usuarioActual));
        console.log('  ✓ Sesión guardada en localStorage');
        console.log(`  ✓✓✓ LOGIN EXITOSO para usuario: ${usuario}`);
        
        return this.usuarioActual;
    }

    // Logout
    logout() {
        const usuario = this.usuarioActual?.usuario || 'desconocido';
        this.usuarioActual = null;
        localStorage.removeItem(SESSION_KEY);
        console.log(`[AUDITORÍA] Usuario ${usuario} se deslogueó`);
    }

    // Eliminar usuario (solo admin)
    eliminarUsuario(usuarioId) {
        if (!this.esAdmin()) {
            throw new Error('Solo administradores pueden eliminar usuarios');
        }

        const usuarios = this.obtenerTodosLosUsuarios();
        const indice = usuarios.findIndex(u => u.id === usuarioId);

        if (indice === -1) {
            throw new Error('Usuario no encontrado');
        }

        const usuarioEliminado = usuarios[indice];
        usuarios.splice(indice, 1);
        localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(usuarios));

        console.log(`[AUDITORÍA] Usuario ${this.usuarioActual.usuario} eliminó usuario: ${usuarioEliminado.usuario}`);

        return usuarioEliminado;
    }

    // Actualizar usuario (solo admin)
    actualizarUsuario(usuarioId, actualizaciones) {
        if (!this.esAdmin()) {
            throw new Error('Solo administradores pueden actualizar usuarios');
        }

        const usuarios = this.obtenerTodosLosUsuarios();
        const usuario = usuarios.find(u => u.id === usuarioId);

        if (!usuario) {
            throw new Error('Usuario no encontrado');
        }

        // Si se proporciona un nuevo nombre de usuario, validar que no exista
        if (actualizaciones.usuario && actualizaciones.usuario !== usuario.usuario) {
            const usuarioExistente = usuarios.find(u => u.usuario === actualizaciones.usuario);
            if (usuarioExistente) {
                throw new Error(`El usuario "${actualizaciones.usuario}" ya existe`);
            }
            usuario.usuario = actualizaciones.usuario.trim();
        }

        // Si se proporciona nueva contraseña
        if (actualizaciones.contraseña) {
            usuario.contraseña = this.hashearContraseña(actualizaciones.contraseña);
        }

        // Actualizar rol si se proporciona
        if (actualizaciones.rol) {
            usuario.rol = actualizaciones.rol;
        }

        // Actualizar centro si se proporciona y no hay otro usuario en ese centro (si es usuario de centro)
        if (actualizaciones.centro && actualizaciones.rol === 'usuario') {
            if (actualizaciones.centro !== usuario.centro) {
                const usuarioCentro = usuarios.find(u => u.centro === actualizaciones.centro && u.rol === 'usuario' && u.id !== usuarioId);
                if (usuarioCentro) {
                    throw new Error(`Ya existe un usuario para el centro "${actualizaciones.centro}". Solo se permite un usuario por centro.`);
                }
            }
            usuario.centro = actualizaciones.centro;
        }

        usuario.actualizado_en = new Date().toISOString();
        localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(usuarios));

        console.log(`[AUDITORÍA] Usuario ${this.usuarioActual.usuario} actualizó usuario: ${usuario.usuario}`);

        return usuario;
    }

    // Obtener todos los centros disponibles
    obtenerCentros() {
        // Este método debe coordinar con el catálogo de establecimientos
        // Por ahora retorna una lista que se puede obtener del formulario
        const usuarios = this.obtenerTodosLosUsuarios();
        const centrosUnicos = [...new Set(usuarios.map(u => u.centro))];
        return centrosUnicos.sort();
    }

    // Inicializar con usuario administrador por defecto si no existe ninguno
    inicializarAdmin() {
        const usuarios = this.obtenerTodosLosUsuarios();
        
        // Si no hay usuarios, crear el admin
        if (usuarios.length === 0) {
            const contraseñaHash = this.hashearContraseña('admin123');
            console.log('Hash generado para admin123:', contraseñaHash);
            
            const adminPorDefecto = {
                id: 'usr_admin_default_' + Date.now(),
                usuario: 'admin',
                contraseña: contraseñaHash,
                rol: 'admin',
                centro: 'ADMINISTRACIÓN',
                creado_en: new Date().toISOString(),
                activo: true
            };
            
            localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify([adminPorDefecto]));
            console.log('✓ Usuario administrador por defecto creado: admin / admin123');
            console.log('Usuarios en localStorage:', localStorage.getItem(AUTH_STORAGE_KEY));
            return true;
        }
        
        // Si hay usuarios, mostrar la contraseña hasheada del admin para debug
        const admin = usuarios.find(u => u.usuario === 'admin');
        if (admin) {
            console.log('Admin encontrado en BD. Hash almacenado:', admin.contraseña);
        }
        
        return false;
    }
    
    // Función para resetear todo (útil para debugging)
    resetearSistema() {
        localStorage.removeItem(AUTH_STORAGE_KEY);
        localStorage.removeItem(SESSION_KEY);
        this.usuarioActual = null;
        this.inicializarAdmin();
        console.log('✓ Sistema reseteado');
    }
}

// Instancia global del sistema de autenticación
const auth = new AutenticacionSistema();

// Inicializar admin si es la primera vez
auth.inicializarAdmin();
