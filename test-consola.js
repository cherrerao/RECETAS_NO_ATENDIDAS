// SCRIPT DE TEST PARA LA CONSOLA DEL NAVEGADOR
// Copia y pega esto en la consola (F12) para verificar que todo funciona

console.log('=== VERIFICACIÓN DEL SISTEMA DE AUTENTICACIÓN ===');

// 1. Verificar que auth existe
console.log('✓ auth existe:', typeof auth !== 'undefined');

// 2. Verificar usuarios
const usuarios = auth.obtenerTodosLosUsuarios();
console.log('✓ Usuarios registrados:', usuarios);

// 3. Verificar hash
const hashTest = auth.hashearContraseña('admin123');
console.log('✓ Hash de "admin123":', hashTest);

// 4. Buscar admin
const admin = usuarios.find(u => u.usuario === 'admin');
console.log('✓ Admin encontrado:', admin);

// 5. Comparar hashes
if (admin) {
    console.log('✓ ¿Hashes coinciden?:', admin.contraseña === hashTest);
}

// 6. Intentar login
try {
    console.log('Intentando login...');
    const resultado = auth.login('admin', 'admin123');
    console.log('✓✓✓ LOGIN EXITOSO:', resultado);
} catch (error) {
    console.error('✗✗✗ LOGIN FALLIDO:', error.message);
}

console.log('=== FIN DE VERIFICACIÓN ===');

// Comandos útiles:
console.log(`
COMANDOS ÚTILES EN CONSOLA:
  - auth.resetearSistema()
  - auth.obtenerTodosLosUsuarios()
  - auth.login('admin', 'admin123')
  - localStorage.clear()
`);
