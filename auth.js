const jwt = require('jsonwebtoken');
require('dotenv').config();
const { pool } = require('./init_db');

const JWT_SECRET = process.env.JWT_SECRET || 'teacher-replacement-system-secret-key-2025';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'admin123').trim();
const TEACHER_PASSWORD = (process.env.TEACHER_PASSWORD || 'teacher123').trim();
const ADMIN_EMAIL = 'admin@university.ru';

if (process.env.NODE_ENV === 'production') {
    if (!process.env.JWT_SECRET) {
        console.warn('⚠️  JWT_SECRET не задан — задайте его в переменных окружения сервера');
    }
    if (!process.env.ADMIN_PASSWORD || !process.env.TEACHER_PASSWORD) {
        console.warn('⚠️  ADMIN_PASSWORD и TEACHER_PASSWORD рекомендуется задать в production');
    }
}

class Auth {
    static isPasswordValid(role, password) {
        if (!password) return false;
        const normalizedRole = String(role || '').trim().toLowerCase();
        if (normalizedRole === 'admin') {
            return password === ADMIN_PASSWORD;
        }
        return password === TEACHER_PASSWORD;
    }

    static async login(email, password) {
        try {
            console.log('🔐 Попытка входа для:', email);

            if (!email || !password) {
                return {
                    success: false,
                    message: 'Email и пароль обязательны'
                };
            }

            const userResult = await pool.query(
                `SELECT u.email, u.role, u.teacher_name, t.name as full_name
                 FROM api.users u
                 LEFT JOIN teachers t ON u.teacher_name = t.name
                 WHERE u.email = $1`,
                [email.trim().toLowerCase()]
            );

            if (userResult.rows.length === 0) {
                console.log('❌ Пользователь не найден:', email);
                if (email.trim().toLowerCase() === ADMIN_EMAIL) {
                    console.log('💡 Учётная запись admin@university.ru отсутствует в api.users — перезапустите сервер или выполните npm run init-db');
                }
                return {
                    success: false,
                    message: 'Неверный email или пароль'
                };
            }

            const dbUser = userResult.rows[0];
            const normalizedRole = String(dbUser.role || '').trim().toLowerCase();

            if (!Auth.isPasswordValid(normalizedRole, password)) {
                console.log('❌ Неверный пароль для роли:', dbUser.role);
                if (normalizedRole === 'admin') {
                    console.log('💡 Для администратора используется пароль из ADMIN_PASSWORD (по умолчанию: admin123), не teacher123');
                }
                return {
                    success: false,
                    message: normalizedRole === 'admin'
                        ? 'Неверный пароль администратора. Используйте admin123 (или значение ADMIN_PASSWORD в .env)'
                        : 'Неверный email или пароль'
                };
            }
            
            console.log('✅ Пользователь найден:', {
                email: dbUser.email,
                role: dbUser.role,
                teacher_name: dbUser.teacher_name,
                full_name: dbUser.full_name
            });
            
            const displayName = dbUser.role === 'admin'
                ? (dbUser.teacher_name
                    ? `Администратор (${dbUser.full_name || dbUser.teacher_name})`
                    : 'Администратор')
                : (dbUser.full_name || dbUser.teacher_name || dbUser.email);

            const token = jwt.sign(
                {
                    email: dbUser.email,
                    role: dbUser.role,
                    teacher_name: dbUser.teacher_name,
                    full_name: displayName
                },
                JWT_SECRET,
                { expiresIn: JWT_EXPIRES_IN }
            );
            
            console.log('✅ Токен сгенерирован (длина:', token.length, 'символов)');
            
            return {
                success: true,
                token,
                user: {
                    email: dbUser.email,
                    role: dbUser.role,
                    teacher_name: dbUser.teacher_name,
                    full_name: displayName
                }
            };
            
        } catch (error) {
            console.error('❌ Ошибка при входе:', error.message);
            console.error('❌ Stack:', error.stack);
            return {
                success: false,
                message: error.message
            };
        }
    }

    // Верификация токена
    static verifyToken(token) {
        console.log('🔐 Проверка токена. Длина:', token?.length || 0);
        
        if (!token) {
            throw new Error('Токен не предоставлен');
        }
        
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            console.log('✅ Токен валиден для:', decoded.email);
            return decoded;
        } catch (error) {
            console.error('❌ Ошибка верификации токена:', error.message);
            console.error('❌ Тип ошибки:', error.name);
            throw new Error(`Неверный или просроченный токен: ${error.message}`);
        }
    }

    // Middleware для проверки аутентификации
    static async authenticateToken(req, res, next) {
        console.log('\n🔐 ========== Middleware authenticateToken ==========');
        console.log('🌐 URL:', req.originalUrl);
        
        // Разрешаем тестовый маршрут без аутентификации
        if (req.originalUrl === '/api/test-schedule') {
            console.log('✅ Пропускаем аутентификацию для тестового маршрута');
            return next();
        }
        
        const authHeader = req.headers['authorization'];
        
        if (!authHeader) {
            console.warn('⚠️ Заголовок Authorization отсутствует');
            return res.status(401).json({ 
                success: false, 
                message: 'Требуется аутентификация'
            });
        }
        
        const parts = authHeader.split(' ');
        
        if (parts.length !== 2 || parts[0] !== 'Bearer') {
            console.warn('⚠️ Неверный формат заголовка Authorization');
            return res.status(401).json({ 
                success: false, 
                message: 'Неверный формат токена. Используйте: Bearer <token>'
            });
        }
        
        const token = parts[1];
        
        if (!token) {
            console.warn('⚠️ Токен пустой');
            return res.status(401).json({ 
                success: false, 
                message: 'Токен не предоставлен'
            });
        }
        
        console.log('🔑 Токен получен (длина:', token.length, 'символов)');
        
        try {
            const decoded = Auth.verifyToken(token);
            console.log('✅ Аутентификация успешна! Пользователь:', decoded.email);

            if (decoded.email) {
                const freshUser = await pool.query(
                    'SELECT role, teacher_name FROM api.users WHERE email = $1',
                    [decoded.email.trim().toLowerCase()]
                );
                if (freshUser.rows[0]) {
                    decoded.role = freshUser.rows[0].role;
                    decoded.teacher_name = freshUser.rows[0].teacher_name;
                }
            }
            
            req.user = decoded;
            next();
            
        } catch (error) {
            console.error('❌ Аутентификация не удалась:', error.message);
            return res.status(401).json({ 
                success: false, 
                message: 'Неверный или просроченный токен'
            });
        }
    }

    // Доступ только для администратора
    static requireAdmin(req, res, next) {
        const role = String(req.user?.role || '').trim().toLowerCase();
        if (role !== 'admin') {
            return res.status(403).json({
                success: false,
                message: 'Доступ только для администратора'
            });
        }
        next();
    }

    // Получение информации о текущем пользователе (для /api/profile и др.)
    static async getCurrentUser(email) {
        try {
            if (!email) {
                throw new Error('Email не указан');
            }

            const result = await pool.query(
                `SELECT u.email, u.role, u.teacher_name, u.created_at,
                        t.name AS teacher_full_name, t.phone
                 FROM api.users u
                 LEFT JOIN teachers t ON u.teacher_name = t.name
                 WHERE u.email = $1`,
                [email.trim().toLowerCase()]
            );

            if (result.rows.length === 0) {
                throw new Error('Пользователь не найден');
            }

            const dbUser = result.rows[0];
            const fullName = dbUser.role === 'admin'
                ? (dbUser.teacher_name
                    ? `Администратор (${dbUser.teacher_full_name || dbUser.teacher_name})`
                    : 'Администратор')
                : (dbUser.teacher_full_name || dbUser.teacher_name || dbUser.email);

            return {
                success: true,
                user: {
                    email: dbUser.email,
                    role: dbUser.role,
                    teacher_name: dbUser.teacher_name,
                    full_name: fullName,
                    phone: dbUser.phone || null,
                    created_at: dbUser.created_at
                }
            };
        } catch (error) {
            console.error('❌ Ошибка при получении пользователя:', error.message);
            return {
                success: false,
                message: error.message
            };
        }
    }

    static async updateProfile(email, { phone }) {
        try {
            if (!email) {
                return { success: false, message: 'Email не указан' };
            }

            const userResult = await pool.query(
                `SELECT u.email, u.role, u.teacher_name
                 FROM api.users u
                 WHERE u.email = $1`,
                [email.trim().toLowerCase()]
            );

            if (userResult.rows.length === 0) {
                return { success: false, message: 'Пользователь не найден' };
            }

            const dbUser = userResult.rows[0];
            const normalizedRole = String(dbUser.role || '').trim().toLowerCase();

            if (normalizedRole === 'admin' && !dbUser.teacher_name) {
                return {
                    success: false,
                    message: 'Профиль администратора не содержит телефона. Изменение недоступно.'
                };
            }

            if (!dbUser.teacher_name) {
                return {
                    success: false,
                    message: 'Пользователь не связан с преподавателем'
                };
            }

            const normalizedPhone = phone != null ? String(phone).trim() : '';
            if (!normalizedPhone) {
                return { success: false, message: 'Укажите номер телефона' };
            }

            await pool.query(
                'UPDATE teachers SET phone = $1 WHERE name = $2',
                [normalizedPhone, dbUser.teacher_name]
            );

            return Auth.getCurrentUser(email);
        } catch (error) {
            console.error('❌ Ошибка при обновлении профиля:', error.message);
            return { success: false, message: error.message };
        }
    }
}

module.exports = Auth;