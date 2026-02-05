// ==========================================
// SCRIPT PARA EJECUTAR EN LA CONSOLA (F12)
// ==========================================

// 1. PRIMERO: Limpiar todo
console.log('=== PASO 1: Limpiar localStorage ===');
localStorage.clear();
console.log('✓ localStorage limpiado');

// 2. Recargar la página para que se re-inicialice
console.log('Recargando página...');
location.reload();

// Después de la recarga, ejecuta esto en la consola:
/*
console.log('=== PASO 2: Verificar usuarios ===');
console.log(JSON.stringify(auth.obtenerTodosLosUsuarios(), null, 2));

console.log('=== PASO 3: Intentar login ===');
try {
    auth.login('admin', 'admin123');
    console.log('✓✓✓ LOGIN EXITOSO');
} catch (e) {
    console.log('Error:', e.message);
}
*/
