const { pool, ensureAdminUser, ensureAdminTeacherLink } = require('./init_db');

async function addAdmin() {
    try {
        await ensureAdminUser();
        await ensureAdminTeacherLink();
        const result = await pool.query(
            'SELECT email, role FROM api.users WHERE email = $1',
            ['admin@university.ru']
        );
        if (result.rows.length > 0) {
            console.log('✅ Администратор готов к входу:');
            console.log('   Email: admin@university.ru');
            console.log('   Пароль: значение ADMIN_PASSWORD из .env (по умолчанию admin123)');
        }
    } catch (err) {
        console.error('❌ Ошибка:', err.message);
    } finally {
        await pool.end();
    }
}

addAdmin();
