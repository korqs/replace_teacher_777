const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { importScheduleFromCsv, DEFAULT_CSV_PATH } = require('./schedule-import');
const { ensureArchiveSchema } = require('./request-retention');

const DEFAULT_DB_NAME = 'teacher_replacement_db';

function getDatabaseName() {
    if (process.env.DB_NAME) {
        return process.env.DB_NAME;
    }
    if (process.env.DATABASE_URL) {
        try {
            const pathname = new URL(process.env.DATABASE_URL).pathname;
            return pathname.replace(/^\//, '') || DEFAULT_DB_NAME;
        } catch (_) {
            return DEFAULT_DB_NAME;
        }
    }
    return DEFAULT_DB_NAME;
}

function splitSqlCommands(sql) {
    const withoutLineComments = sql.replace(/--[^\r\n]*/g, '');
    const withoutComments = withoutLineComments.replace(/\/\*[\s\S]*?\*\//g, '');
    return withoutComments.split(';').filter(cmd => cmd.trim().length > 0);
}

function buildPoolConfig() {
    const base = {
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
    };

    if (process.env.DATABASE_URL) {
        const config = {
            ...base,
            connectionString: process.env.DATABASE_URL,
        };
        if (process.env.DATABASE_SSL === 'true') {
            config.ssl = { rejectUnauthorized: false };
        }
        return config;
    }

    return {
        ...base,
        user: process.env.DB_USER || 'postgres',
        host: process.env.DB_HOST || 'localhost',
        database: process.env.DB_NAME || DEFAULT_DB_NAME,
        password: process.env.DB_PASSWORD || process.env.DB_PASS || '',
        port: parseInt(process.env.DB_PORT || '5432', 10),
    };
}

console.log('🔧 Подключение к PostgreSQL...');
if (process.env.DATABASE_URL) {
    console.log('   Режим: DATABASE_URL');
    console.log(`   База: ${getDatabaseName()}`);
} else {
    console.log(`   Host: ${process.env.DB_HOST || 'localhost'}`);
    console.log(`   Database: ${process.env.DB_NAME || DEFAULT_DB_NAME}`);
    console.log(`   User: ${process.env.DB_USER || 'postgres'}`);
}

const pool = new Pool(buildPoolConfig());

pool.on('connect', (client) => {
    client.query("SET client_encoding TO 'UTF8'").catch(() => {});
});

async function logDatabaseEncoding(client) {
    try {
        const result = await client.query('SHOW server_encoding');
        const encoding = result.rows[0]?.server_encoding || 'unknown';
        console.log(`   Кодировка БД: ${encoding}`);
        if (encoding !== 'UTF8') {
            console.warn('⚠️  База не в UTF-8 — кириллица может отображаться как ???');
            console.warn('   Пересоздайте базу с кодировкой UTF8 и выполните init-db заново');
        }
    } catch (_) {
        // ignore
    }
}

// ФУНКЦИЯ ДЛЯ ПРОВЕРКИ ПОДКЛЮЧЕНИЯ (нужна для server.js)
const testConnection = async () => {
    try {
        const client = await pool.connect();
        console.log('✅ Успешное подключение к PostgreSQL!');
        
        // Быстрая проверка
        const result = await client.query('SELECT version()');
        console.log(`📊 Версия PostgreSQL: ${result.rows[0].version.split(',')[0]}`);
        
        // Проверяем таблицы
        const tables = await client.query(`
            SELECT table_schema, table_name 
            FROM information_schema.tables 
            WHERE table_schema IN ('public', 'api')
            ORDER BY table_schema, table_name
        `);
        
        if (tables.rows.length > 0) {
            console.log('📋 Найдены таблицы:');
            const tablesBySchema = {};
            tables.rows.forEach(table => {
                if (!tablesBySchema[table.table_schema]) {
                    tablesBySchema[table.table_schema] = [];
                }
                tablesBySchema[table.table_schema].push(table.table_name);
            });
            
            for (const schema in tablesBySchema) {
                console.log(`   📁 Схема ${schema}:`);
                tablesBySchema[schema].forEach(table => {
                    console.log(`     - ${table}`);
                });
            }
        } else {
            console.log('⚠️  Таблицы не найдены. Возможно, база данных пуста.');
        }
        
        client.release();
        return true;
    } catch (error) {
        console.error('❌ Ошибка подключения к PostgreSQL:', error.message);
        
        // Полезные подсказки
        if (error.message.includes('password authentication failed')) {
            console.log('💡 Проверьте пароль в .env файле (DB_PASSWORD или DB_PASS)');
        } else if (error.message.includes('connect ECONNREFUSED')) {
            console.log('💡 PostgreSQL не запущен. Запустите: brew services start postgresql');
        } else if (error.message.includes('database')) {
            console.log('💡 База данных не существует. Создайте её в pgAdmin');
        }
        
        return false;
    }
};

// ФУНКЦИЯ ДЛЯ ИНИЦИАЛИЗАЦИИ БАЗЫ ДАННЫХ
async function initDB() {
    let client;
    
    try {
        console.log('\n🚀 Начинаю инициализацию базы данных...');
        console.log('──────────────────────────────────────────');
        
        client = await pool.connect();
        console.log('✅ Подключение к PostgreSQL успешно!');
        await logDatabaseEncoding(client);
        
        // Проверяем, существует ли база данных
        const dbCheck = await client.query(
            "SELECT 1 FROM pg_database WHERE datname = $1",
            [getDatabaseName()]
        );
        
        if (dbCheck.rows.length === 0) {
            console.log('❌ База данных не найдена!');
            console.log('ℹ️  Создайте базу данных через pgAdmin:');
            console.log('   1. Откройте pgAdmin');
            console.log('   2. Правой кнопкой на Databases -> Create -> Database');
            console.log('   3. Имя: teacher_replacement_db');
            console.log('   4. Owner: postgres');
            console.log('   5. Нажмите Save');
            process.exit(1);
        }
        
        // Читаем SQL файл
        const sqlPath = path.join(__dirname, 'database.sql');
        console.log(`📖 Читаю SQL файл: ${sqlPath}`);
        
        if (!fs.existsSync(sqlPath)) {
            console.error(`❌ Файл database.sql не найден по пути: ${sqlPath}`);
            console.log('ℹ️  Убедитесь, что файл database.sql находится в той же папке, что и init_db.js');
            process.exit(1);
        }
        
        const sql = fs.readFileSync(sqlPath, 'utf8');
        console.log('✅ SQL файл успешно прочитан');

        const commands = splitSqlCommands(sql);
        
        console.log(`🔄 Начинаю выполнение ${commands.length} SQL команд...`);
        
        let successCount = 0;
        let errorCount = 0;
        
        for (let i = 0; i < commands.length; i++) {
            const command = commands[i].trim();
            
            // Пропускаем пустые строки и комментарии
            if (!command || command.startsWith('--') || command.startsWith('/*')) {
                continue;
            }
            
            try {
                await client.query(command);
                successCount++;
                
            } catch (error) {
                errorCount++;
                
                if (error.message.includes('already exists') || 
                    error.message.includes('существует')) {
                    // Не выводим эти ошибки в консоль
                } else {
                    console.error(`❌ Ошибка в команде ${i + 1}:`, error.message);
                }
            }
        }
        
        console.log('──────────────────────────────────────────');
        console.log('📊 Результаты выполнения:');
        console.log(`   ✅ Успешно: ${successCount} команд`);
        console.log(`   ⚠️  Пропущено (уже существуют): ${errorCount} команд`);
        
        // Проверяем, что данные создались
        console.log('\n🔍 Проверяем созданные данные...');
        
        const tables = ['teachers', 'timetable', 'replacement_requests'];
        
        for (const table of tables) {
            try {
                const result = await client.query(`SELECT COUNT(*) as count FROM ${table}`);
                console.log(`   📋 ${table}: ${result.rows[0].count} записей`);
            } catch (error) {
                console.log(`   ❌ ${table}: таблица не найдена`);
            }
        }

        if (fs.existsSync(DEFAULT_CSV_PATH)) {
            console.log('\n📅 Импорт расписания из CSV...');
            try {
                const importResult = await importScheduleFromCsv(pool, { client, replace: true });
                console.log(`   ✅ Расписание: ${importResult.imported} записей из ${importResult.file}`);
                if (importResult.skipped > 0) {
                    console.log(`   ⚠️  Пропущено: ${importResult.skipped} (неизвестный преподаватель)`);
                }
            } catch (importError) {
                console.error('   ❌ Ошибка импорта расписания:', importError.message);
            }
        } else {
            console.log(`\n⚠️  Файл расписания не найден: ${DEFAULT_CSV_PATH}`);
        }
        
        await ensureAllTeacherUsers();

        // Проверяем пользователей
        try {
            const usersResult = await client.query('SELECT email, role FROM api.users');
            console.log(`   👤 Пользователи: ${usersResult.rows.length} записей`);
            
            if (usersResult.rows.length > 0) {
                console.log('\n📋 Список пользователей:');
                usersResult.rows.forEach(user => {
                    console.log(`   - ${user.email} (${user.role})`);
                });
            }
        } catch (error) {
            console.log('   ❌ Пользователи: ошибка доступа к таблице users');
        }
        
        console.log('\n🎉 Инициализация базы данных завершена!');
        console.log('==========================================');
        console.log('👨‍🏫 Тестовые учетные записи для входа:');
        console.log('==========================================');
        console.log('Администратор:');
        console.log('   📧 Email: admin@university.ru');
        console.log('   🔑 Пароль: admin123');
        console.log('\nПреподаватели (все с паролем "teacher123"):');
        console.log('   📧 milehina@university.ru - Милехина');
        console.log('   📧 zaharova@university.ru - Захарова');
        console.log('   📧 zubarev@university.ru - Зубарев');
        console.log('   📧 oblakova@university.ru - Облакова');
        console.log('   📧 algazin@university.ru - Алгазин');
        console.log('==========================================');
        
    } catch (error) {
        console.error('❌ Критическая ошибка при инициализации базы данных:');
        console.error(error.message);
        console.error('\n🔧 Возможные решения:');
        console.error('   1. Проверьте, запущен ли PostgreSQL');
        console.error('   2. Проверьте параметры подключения в файле .env');
        console.error('   3. Убедитесь, что база данных существует в pgAdmin');
        console.error('   4. Проверьте правильность пароля пользователя');
        
    } finally {
        if (client) {
            client.release();
        }
        // Не закрываем пул, так как он нужен для работы сервера
        console.log('\n🔧 Пул соединений готов к использованию сервером');
    }
}

const ADMIN_EMAIL = 'admin@university.ru';
const ADMIN_TEACHER_NAME = 'Администратор';
const ENV_MANAGED_PASSWORD_HASH = 'env-managed';

/** Гарантирует, что администратор также числится преподавателем (двойная роль) */
async function ensureAdminTeacherLink() {
    try {
        await pool.query(
            `INSERT INTO teachers (name, email, phone)
             VALUES ($1, $2, '+7 (999) 111-11-11')
             ON CONFLICT (name) DO NOTHING`,
            [ADMIN_TEACHER_NAME, ADMIN_EMAIL]
        );

        await pool.query(
            `UPDATE api.users
             SET teacher_name = $1
             WHERE email = $2 AND (teacher_name IS NULL OR teacher_name = '')`,
            [ADMIN_TEACHER_NAME, ADMIN_EMAIL]
        );
    } catch (error) {
        if (error.message.includes('relation') && error.message.includes('teachers')) {
            console.warn('⚠️ Таблица teachers не найдена — выполните npm run init-db');
        } else {
            console.warn('⚠️ Не удалось связать администратора с преподавателем:', error.message);
        }
    }
}

/** Гарантирует наличие admin@university.ru в api.users (частая причина «админ не входит») */
async function ensureAdminUser() {
    try {
        const existing = await pool.query(
            'SELECT email, role FROM api.users WHERE email = $1',
            [ADMIN_EMAIL]
        );

        if (existing.rows.length === 0) {
            await pool.query(
                `INSERT INTO api.users (email, password_hash, role, teacher_name)
                 VALUES ($1, $2, 'admin', $3)`,
                [ADMIN_EMAIL, ENV_MANAGED_PASSWORD_HASH, ADMIN_TEACHER_NAME]
            );
            console.log(`✅ Создана учётная запись администратора: ${ADMIN_EMAIL}`);
            await ensureAdminTeacherLink();
            return;
        }

        const row = existing.rows[0];
        if (String(row.role || '').trim().toLowerCase() !== 'admin') {
            await pool.query(
                `UPDATE api.users SET role = 'admin' WHERE email = $1`,
                [ADMIN_EMAIL]
            );
            console.log(`✅ Исправлена роль администратора для ${ADMIN_EMAIL} (было: ${row.role})`);
        }

        await ensureAdminTeacherLink();
    } catch (error) {
        if (error.message.includes('relation') && error.message.includes('users')) {
            console.warn('⚠️ Таблица api.users не найдена — выполните npm run init-db');
        } else {
            console.warn('⚠️ Не удалось проверить учётную запись администратора:', error.message);
        }
    }
}

/** Создаёт учётные записи для всех преподавателей из teachers */
async function ensureAllTeacherUsers() {
    try {
        const teachers = await pool.query('SELECT name, email FROM teachers ORDER BY name');
        if (teachers.rows.length === 0) {
            return;
        }

        let created = 0;
        let updated = 0;

        for (const row of teachers.rows) {
            const role = row.name === ADMIN_TEACHER_NAME ? 'admin' : 'teacher';
            const existing = await pool.query(
                'SELECT email, teacher_name, role FROM api.users WHERE email = $1',
                [row.email]
            );

            if (existing.rows.length === 0) {
                await pool.query(
                    `INSERT INTO api.users (email, password_hash, role, teacher_name)
                     VALUES ($1, $2, $3, $4)`,
                    [row.email, ENV_MANAGED_PASSWORD_HASH, role, row.name]
                );
                created++;
            } else {
                const user = existing.rows[0];
                if (user.teacher_name !== row.name || user.role !== role) {
                    await pool.query(
                        `UPDATE api.users
                         SET teacher_name = $1, role = $2
                         WHERE email = $3`,
                        [row.name, role, row.email]
                    );
                    updated++;
                }
            }
        }

        if (created > 0 || updated > 0) {
            console.log(`✅ Учётные записи преподавателей: создано ${created}, обновлено ${updated}`);
        }
    } catch (error) {
        if (error.message.includes('relation') && error.message.includes('users')) {
            console.warn('⚠️ Таблица api.users не найдена — выполните npm run init-db');
        } else {
            console.warn('⚠️ Синхронизация учётных записей преподавателей:', error.message);
        }
    }
}

/** Добавляет audiense и type в timetable для существующих баз */
async function migrateTimetableLessonFields() {
    try {
        const tableCheck = await pool.query(`SELECT to_regclass('public.timetable') AS t`);
        if (!tableCheck.rows[0]?.t) {
            return;
        }

        await pool.query('ALTER TABLE timetable ADD COLUMN IF NOT EXISTS audiense TEXT');
        await pool.query('ALTER TABLE timetable ADD COLUMN IF NOT EXISTS type TEXT');
    } catch (error) {
        console.warn('⚠️ Миграция полей audiense/type:', error.message);
    }
}

/** Переименование устаревших сокращений предметов в заявках */
const LEGACY_SUBJECT_RENAMES = [
    ['Матан', 'Математический анализ'],
    ['Линал', 'Линейная алгебра'],
    ['БД', 'Базы данных'],
    ['ТФКП', 'Дискретная математика'],
    ['Тервер', 'Программирование'],
];

async function migrateSubjectNames() {
    try {
        let renamed = 0;
        for (const [oldName, newName] of LEGACY_SUBJECT_RENAMES) {
            const requests = await pool.query(
                'UPDATE replacement_requests SET subject = $2 WHERE subject = $1',
                [oldName, newName]
            );
            renamed += requests.rowCount;
        }

        if (renamed > 0) {
            console.log(`✅ Переименовано записей в заявках: ${renamed}`);
        }
    } catch (error) {
        console.warn('⚠️ Миграция названий предметов:', error.message);
    }
}

/** Первичная инициализация, если схема ещё не создана (безопасно при повторных запусках) */
async function bootstrapDatabase() {
    try {
        const client = await pool.connect();
        let needsInit = false;
        try {
            const check = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_schema = 'api' AND table_name = 'users'
                ) AS ready
            `);
            needsInit = !check.rows[0]?.ready;
        } finally {
            client.release();
        }

        if (needsInit) {
            console.log('📦 База данных пуста — выполняется первичная инициализация...');
            await initDB();
        } else {
            await migrateSubjectNames();
            await migrateTimetableLessonFields();
            await ensureAdminUser();
            await ensureAdminTeacherLink();
            await ensureAllTeacherUsers();
        }
        await ensureArchiveSchema(pool);
    } catch (error) {
        console.warn('⚠️ Не удалось выполнить bootstrap базы данных:', error.message);
    }
}

// ЭКСПОРТЫ ДЛЯ СЕРВЕРА
module.exports = {
    pool,
    testConnection,
    initDB,
    ensureAdminUser,
    ensureAdminTeacherLink,
    ensureAllTeacherUsers,
    bootstrapDatabase,
    migrateSubjectNames,
    migrateTimetableLessonFields,
    ADMIN_TEACHER_NAME
};

// ЕСЛИ ФАЙЛ ЗАПУЩЕН НАПРЯМУЮ
if (require.main === module) {
    console.log('🚀 Запуск скрипта инициализации БД...');
    console.log('ℹ️  Этот скрипт создает таблицы и тестовые данные');
    console.log('──────────────────────────────────────────');

    const autoYes = process.argv.includes('--yes') || process.argv.includes('-y');

    const finish = async (runInit) => {
        if (runInit) {
            await initDB();
        } else {
            console.log('⏭️  Пропускаем инициализацию БД');
            console.log('🔍 Проверяем подключение к существующей БД...');
            await testConnection();
        }

        console.log('\n🚀 Для запуска сервера выполните: npm start');
        console.log('🌐 Затем откройте в браузере: http://localhost:3000');
        process.exit(0);
    };

    if (autoYes) {
        finish(true).catch((error) => {
            console.error('❌ Ошибка инициализации:', error.message);
            process.exit(1);
        });
    } else {
        const readline = require('readline').createInterface({
            input: process.stdin,
            output: process.stdout
        });

        readline.question('❓ Создать/обновить базу данных? (y/N): ', async (answer) => {
            const runInit = answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
            readline.close();
            try {
                await finish(runInit);
            } catch (error) {
                console.error('❌ Ошибка инициализации:', error.message);
                process.exit(1);
            }
        });
    }
}
