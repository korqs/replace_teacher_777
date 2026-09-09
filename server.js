const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
require('dotenv').config();

const { pool, testConnection, bootstrapDatabase, ADMIN_TEACHER_NAME } = require('./init_db');
const { ensureScheduleLoaded, getDayOfWeek, resolveLessonMeta } = require('./schedule-import');
const {
    mapLessonTypeToCompetency,
    fetchLessonCountsByTeacher,
    buildTeacherCompetency
} = require('./competency');
const Auth = require('./auth');

const { isEmailEnabled } = require('./mail');
const {
    notifyInBackground,
    notifyNewReplacementRequest,
    notifyRequestResponded,
    notifyRequestCancelled
} = require('./request-emails');
const {
    REQUEST_RETENTION_MONTHS,
    getRetentionCutoffSql,
    ensureArchiveSchema,
    runRequestRetention,
    scheduleRequestRetention
} = require('./request-retention');


const app = express();
const PORT = process.env.PORT || 3000;

const REQUEST_STATUSES = ['pending', 'confirmed', 'rejected', 'cancelled'];

function isDatabaseError(message = '') {
    return /password authentication failed|ECONNREFUSED|connect ETIMEDOUT|does not exist|connection terminated|getaddrinfo/i.test(message);
}

function getDbConnectionErrorMessage(rawMessage = '') {
    if (/password authentication failed/i.test(rawMessage)) {
        return 'Не удалось подключиться к базе данных: неверный пароль PostgreSQL. Укажите DB_PASSWORD в файле .env (для Docker: postgres).';
    }
    if (/ECONNREFUSED|connect ETIMEDOUT|getaddrinfo/i.test(rawMessage)) {
        return 'Не удалось подключиться к базе данных. Запустите PostgreSQL или выполните: docker compose up -d';
    }
    if (/database .* does not exist/i.test(rawMessage)) {
        return 'База данных не найдена. Выполните: npm run init-db';
    }
    return rawMessage;
}

function normalizeDateRange(from, to) {
    if (from && to && from > to) {
        return { from: to, to: from };
    }
    return { from, to };
}

function isAdminUser(user) {
    return String(user?.role || '').trim().toLowerCase() === 'admin';
}

/** Для администратора — преподаватель из query/body; для преподавателя — из профиля */
async function resolveEffectiveTeacher(req, options = {}) {
    const {
        bodyTeacher,
        queryTeacher,
        requireTeacher = true,
        adminMessage = 'Выберите преподавателя (параметр teacher)'
    } = options;

    if (isAdminUser(req.user)) {
        const requested = String(
            bodyTeacher ||
            queryTeacher ||
            req.query?.teacher ||
            req.query?.applicant ||
            ''
        ).trim();

        if (!requested) {
            if (!requireTeacher) {
                return { teacherName: null };
            }
            return { error: adminMessage };
        }

        if (requested === ADMIN_TEACHER_NAME) {
            return { error: 'Выберите преподавателя из списка (не «Администратор»)' };
        }

        const check = await pool.query('SELECT name FROM teachers WHERE name = $1', [requested]);
        if (check.rows.length === 0) {
            return { error: 'Преподаватель не найден' };
        }

        return { teacherName: requested };
    }

    const teacherName = req.user.teacher_name;
    if (!teacherName) {
        return { error: 'Пользователь не связан с преподавателем' };
    }

    return { teacherName };
}

function buildAdminListFilters(query, tableAlias = 'r') {
    const { status, teacher } = query;
    const { from, to } = normalizeDateRange(query.from, query.to);
    const conditions = [];
    const params = [];

    if (from) {
        params.push(from);
        conditions.push(`${tableAlias}.request_date >= $${params.length}`);
    }
    if (to) {
        params.push(to);
        conditions.push(`${tableAlias}.request_date <= $${params.length}`);
    }
    if (status) {
        if (!REQUEST_STATUSES.includes(status)) {
            return { error: `Недопустимый статус. Допустимые: ${REQUEST_STATUSES.join(', ')}` };
        }
        params.push(status);
        conditions.push(`${tableAlias}.status = $${params.length}`);
    }
    if (teacher) {
        const name = String(teacher).trim();
        if (name) {
            params.push(`%${name}%`);
            const i = params.length;
            conditions.push(
                `(${tableAlias}.teacher_name ILIKE $${i} OR ${tableAlias}.replacing_teacher ILIKE $${i})`
            );
        }
    }

    return { conditions, params };
}

const LESSON_META_LATERAL_JOIN = `
    LEFT JOIN LATERAL (
        SELECT t_lesson.audiense, t_lesson.type
        FROM timetable t_lesson
        WHERE t_lesson.teacher = r.teacher_name
          AND t_lesson.date = r.request_date
          AND t_lesson.classes = r.classes
          AND t_lesson.subject = r.subject
        ORDER BY t_lesson.is_replacement ASC, t_lesson.id ASC
        LIMIT 1
    ) AS lesson_meta ON true
`;

async function applyReplacementToTimetable(client, request) {
    const replacingTeacher = request.replacing_teacher;
    if (!replacingTeacher) {
        throw new Error('Не указан замещающий преподаватель');
    }

    const dayOfWeek = getDayOfWeek(formatDateFromDb(request.request_date));

    const originalLessonMeta = await client.query(
        `SELECT audiense, type, dinner
         FROM timetable
         WHERE teacher = $1
           AND date = $2
           AND classes = $3
           AND subject = $4
           AND is_replacement = false
         LIMIT 1`,
        [
            request.teacher_name,
            request.request_date,
            request.classes,
            request.subject
        ]
    );
    const lessonMeta = originalLessonMeta.rows[0] || {};

    const existingLesson = await client.query(
        `SELECT id FROM timetable 
         WHERE teacher = $1 AND date = $2 AND classes = $3`,
        [replacingTeacher, request.request_date, request.classes]
    );

    if (existingLesson.rows.length === 0) {
        await client.query(
            `INSERT INTO timetable 
                (subject, classes, dinner, team, teacher, date, 
                 day_of_week, week_num, num_den, audiense, type, is_replacement)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)`,
            [
                request.subject,
                request.classes,
                lessonMeta.dinner || null,
                request.team,
                replacingTeacher,
                request.request_date,
                dayOfWeek,
                request.week_num || 16,
                request.num_den || 'num',
                lessonMeta.audiense || null,
                lessonMeta.type || null
            ]
        );
    }

    const originalLesson = await client.query(
        `SELECT id FROM timetable 
         WHERE teacher = $1 
         AND date = $2 
         AND classes = $3 
         AND subject = $4
         AND is_replacement = false`,
        [
            request.teacher_name,
            request.request_date,
            request.classes,
            request.subject
        ]
    );

    if (originalLesson.rows.length > 0) {
        await client.query(
            `UPDATE timetable SET is_replacement = true WHERE id = $1`,
            [originalLesson.rows[0].id]
        );
    }
}

async function revertReplacementFromTimetable(client, request) {
    if (!request.replacing_teacher) return;

    await client.query(
        `DELETE FROM timetable 
         WHERE teacher = $1 AND date = $2 AND classes = $3 
           AND subject = $4 AND team = $5 AND is_replacement = true`,
        [
            request.replacing_teacher,
            request.request_date,
            request.classes,
            request.subject,
            request.team
        ]
    );

    await client.query(
        `UPDATE timetable 
         SET is_replacement = false
         WHERE teacher = $1 AND date = $2 AND classes = $3 AND subject = $4`,
        [
            request.teacher_name,
            request.request_date,
            request.classes,
            request.subject
        ]
    );
}

// КОНФИГУРАЦИЯ

app.use(helmet({
    contentSecurityPolicy: false
}));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Middleware
app.use(cors({
    origin: process.env.ALLOWED_ORIGIN || 'http://localhost:3000',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Статические файлы
app.use(express.static(path.join(__dirname, 'public'), {
    etag: true,
    maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
    setHeaders(res, filePath) {
        if (process.env.NODE_ENV !== 'production' && /\.(js|html)$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'no-store');
        }
    }
}));




// API МАРШРУТЫ

// Проверка здоровья сервера
app.get('/api/test', (req, res) => {
    res.json({ message: 'Test route works!' });
});

app.get('/api/health', async (req, res) => {
    try {
        const dbStatus = await testConnection();
        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            database: dbStatus ? 'connected' : 'disconnected',
            message: 'Сервер работает корректно!',
            version: '1.0.0'
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

// Тестовый маршрут для расписания (без авторизации)
app.get('/api/test-schedule', async (req, res) => {
    try {
        const { date } = req.query;
        
        const testData = {
            success: true,
            teacher: "Милехина",
            date: date || "2025-12-15",
            schedule: [
                {
                    id: 1,
                    subject: "Линейная алгебра",
                    classes: 1,
                    dinner: null,
                    team: "ФН11-33Б",
                    date: date || "2025-12-15",
                    day_of_week: 1,
                    week_num: 16,
                    num_den: "num",
                    num_den_text: "числитель",
                    is_replacement: false,
                    can_request_replacement: true
                },
                {
                    id: 2,
                    subject: "Математический анализ",
                    classes: 2,
                    dinner: null,
                    team: "ФН11-33Б",
                    date: date || "2025-12-15",
                    day_of_week: 1,
                    week_num: 16,
                    num_den: "num",
                    num_den_text: "числитель",
                    is_replacement: false,
                    can_request_replacement: true
                }
            ]
        };
        
        res.json(testData);
        
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Вход в систему
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        console.log('Запрос на вход:', { email, password: '***' });
        
        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Email и пароль обязательны'
            });
        }
        
        const result = await Auth.login(email, password);
        
        console.log('Результат входа:', result.success ? 'Успешно' : 'Ошибка');
        
        if (result.success) {
            res.json(result);
        } else if (isDatabaseError(result.message)) {
            res.status(503).json({
                success: false,
                message: getDbConnectionErrorMessage(result.message)
            });
        } else {
            res.status(401).json(result);
        }
    } catch (error) {
        console.error('Ошибка при входе:', error);
        res.status(500).json({
            success: false,
            message: 'Ошибка сервера при входе в систему: ' + error.message
        });
    }
});

function formatDateFromDb(value) {
    if (typeof value === 'string') return value.slice(0, 10);
    if (value instanceof Date) {
        const y = value.getUTCFullYear();
        const m = String(value.getUTCMonth() + 1).padStart(2, '0');
        const day = String(value.getUTCDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }
    return String(value).slice(0, 10);
}

const SCHEDULE_LESSON_QUERY = `
    SELECT 
        t.id,
        t.subject,
        t.classes,
        t.dinner,
        t.team,
        t.date,
        EXTRACT(DOW FROM t.date) as day_of_week,
        t.week_num,
        t.num_den,
        t.audiense,
        t.type,
        t.is_replacement,
        CASE t.num_den
            WHEN 'num' THEN 'числитель'
            WHEN 'den' THEN 'знаменатель'
        END as num_den_text,
        (
            SELECT r.replacing_teacher
            FROM replacement_requests r
            WHERE r.teacher_name = t.teacher
              AND r.request_date = t.date
              AND r.classes = t.classes
              AND r.subject = t.subject
              AND r.status = 'confirmed'
            LIMIT 1
        ) AS replaced_by,
        (
            SELECT r.teacher_name
            FROM replacement_requests r
            WHERE r.replacing_teacher = t.teacher
              AND r.request_date = t.date
              AND r.classes = t.classes
              AND r.subject = t.subject
              AND r.status = 'confirmed'
            LIMIT 1
        ) AS covers_for
    FROM timetable t
    WHERE t.teacher = $1
`;

async function fetchTeacherSchedule(teacherName, { date, from, to } = {}) {
    const params = [teacherName];
    let dateClause = '';

    if (date) {
        params.push(date);
        dateClause = ' AND t.date = $2';
    } else if (from && to) {
        params.push(from, to);
        dateClause = ' AND t.date >= $2 AND t.date <= $3';
    } else {
        throw new Error('Укажите date или диапазон from/to');
    }

    const result = await pool.query(
        `${SCHEDULE_LESSON_QUERY}${dateClause} ORDER BY t.date, t.classes`,
        params
    );

    return result.rows.map((lesson) => ({
        ...lesson,
        date: formatDateFromDb(lesson.date),
        can_request_replacement: !lesson.is_replacement
    }));
}

// Получение расписания преподавателя на один день
app.get('/api/schedule', Auth.authenticateToken, async (req, res) => {
    try {
        const { date } = req.query;
        const resolved = await resolveEffectiveTeacher(req, {
            queryTeacher: req.query.teacher,
            adminMessage: 'Выберите преподавателя для просмотра расписания'
        });

        if (resolved.error) {
            return res.status(400).json({ success: false, message: resolved.error });
        }

        const teacherName = resolved.teacherName;

        let queryDate = date;
        if (!queryDate) {
            const firstDateResult = await pool.query(
                `SELECT MIN(date) as first_date FROM timetable WHERE teacher = $1`,
                [teacherName]
            );
            queryDate = formatDateFromDb(firstDateResult.rows[0]?.first_date) || null;
        }

        const schedule = await fetchTeacherSchedule(teacherName, { date: queryDate });

        res.json({
            success: true,
            teacher: teacherName,
            date: queryDate,
            schedule
        });
    } catch (error) {
        console.error('💥 Ошибка в /api/schedule:', error.message);
        res.status(500).json({
            success: false,
            message: 'Внутренняя ошибка сервера: ' + error.message
        });
    }
});

app.get('/api/schedule/week', Auth.authenticateToken, async (req, res) => {
    try {
        const { start } = req.query;
        const resolved = await resolveEffectiveTeacher(req, {
            queryTeacher: req.query.teacher,
            adminMessage: 'Выберите преподавателя для просмотра расписания'
        });

        if (resolved.error) {
            return res.status(400).json({ success: false, message: resolved.error });
        }

        const teacherName = resolved.teacherName;

        if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) {
            return res.status(400).json({
                success: false,
                message: 'Параметр start обязателен (формат YYYY-MM-DD, понедельник недели)'
            });
        }

        const startDate = new Date(`${start}T12:00:00`);
        const endDate = new Date(startDate);
        endDate.setDate(endDate.getDate() + 5);

        const endStr = [
            endDate.getFullYear(),
            String(endDate.getMonth() + 1).padStart(2, '0'),
            String(endDate.getDate()).padStart(2, '0')
        ].join('-');
        const lessons = await fetchTeacherSchedule(teacherName, { from: start, to: endStr });

        const lessonsByDate = {};
        for (const lesson of lessons) {
            if (!lessonsByDate[lesson.date]) lessonsByDate[lesson.date] = [];
            lessonsByDate[lesson.date].push(lesson);
        }

        const dayNames = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
        const days = [];

        for (let i = 0; i < 6; i++) {
            const d = new Date(startDate);
            d.setDate(d.getDate() + i);
            const dateStr = [
                d.getFullYear(),
                String(d.getMonth() + 1).padStart(2, '0'),
                String(d.getDate()).padStart(2, '0')
            ].join('-');
            const dow = d.getDay();

            days.push({
                date: dateStr,
                day_of_week: dow,
                day_name: dayNames[dow],
                schedule: lessonsByDate[dateStr] || []
            });
        }

        res.json({
            success: true,
            teacher: teacherName,
            start,
            end: endStr,
            days
        });
    } catch (error) {
        console.error('💥 Ошибка в /api/schedule/week:', error.message);
        res.status(500).json({
            success: false,
            message: 'Внутренняя ошибка сервера: ' + error.message
        });
    }
});

// История замен для преподавателя
app.get('/api/schedule/replacements', Auth.authenticateToken, async (req, res) => {
    try {
        const teacherName = req.user.teacher_name;
        const { date } = req.query;
        
        if (!teacherName) {
            return res.status(400).json({
                success: false,
                message: 'Пользователь не связан с преподавателем'
            });
        }
        
        let query = `
            SELECT 
                t.id,
                t.subject,
                t.classes,
                t.dinner,
                t.team,
                t.date,
                EXTRACT(DOW FROM t.date) as day_of_week,
                t.week_num,
                t.num_den,
                t.audiense,
                t.type,
                t.is_replacement,
                CASE t.num_den
                    WHEN 'num' THEN 'числитель'
                    WHEN 'den' THEN 'знаменатель'
                END as num_den_text,
                -- Находим информацию о замене
                (SELECT r.replacing_teacher 
                 FROM replacement_requests r
                 WHERE r.teacher_name = $1
                 AND r.request_date = t.date
                 AND r.classes = t.classes
                 AND r.subject = t.subject
                 AND r.status = 'confirmed'
                 LIMIT 1) as replaced_by
            FROM timetable t
            WHERE t.teacher = $1
            AND t.is_replacement = true
        `;
        
        const params = [teacherName];
        
        if (date) {
            query += ' AND t.date = $2';
            params.push(date);
        }
        
        query += ' ORDER BY t.date, t.classes';
        
        const result = await pool.query(query, params);
        
        res.json({
            success: true,
            replacements: result.rows
        });
        
    } catch (error) {
        console.error('❌ Ошибка при получении истории замен:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Доступные даты расписания для текущего преподавателя
app.get('/api/schedule/available-dates', Auth.authenticateToken, async (req, res) => {
    try {
        const resolved = await resolveEffectiveTeacher(req, {
            queryTeacher: req.query.teacher,
            adminMessage: 'Выберите преподавателя для просмотра расписания'
        });

        if (resolved.error) {
            return res.status(400).json({ success: false, message: resolved.error });
        }

        const teacherName = resolved.teacherName;

        console.log('📅 Ищем даты для преподавателя:', teacherName);

        const datesRes = await pool.query(
            `SELECT DISTINCT date
             FROM timetable
             WHERE teacher = $1
             ORDER BY date`,
            [teacherName]
        );

        console.log('📅 Найдено дат для', teacherName, ':', datesRes.rows.length);
        
        const dates = datesRes.rows
            .map((r) => {
                const d = r.date;
                if (typeof d === 'string') return d.slice(0, 10);
                if (d instanceof Date) {
                    const y = d.getUTCFullYear();
                    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
                    const day = String(d.getUTCDate()).padStart(2, '0');
                    return `${y}-${m}-${day}`;
                }
                return String(d).slice(0, 10);
            })
            .filter(Boolean);
        console.log('📅 Даты:', dates);

        res.json({
            success: true,
            dates
        });
    } catch (error) {
        console.error('❌ Ошибка /api/schedule/available-dates:', error);
        res.status(500).json({
            success: false,
            message: 'Внутренняя ошибка сервера: ' + error.message
        });
    }
});

// Список преподавателей (для выбора заявителя администратором)
app.get('/api/teachers/list', Auth.authenticateToken, async (req, res) => {
    try {
        if (!isAdminUser(req.user)) {
            return res.status(403).json({
                success: false,
                message: 'Доступ только для администратора'
            });
        }

        const result = await pool.query(
            `SELECT name, email
             FROM teachers
             WHERE name != $1
             ORDER BY name`,
            [ADMIN_TEACHER_NAME]
        );

        res.json({ success: true, teachers: result.rows });
    } catch (error) {
        console.error('❌ Ошибка при получении списка преподавателей:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ДОСТУПНЫЕ ПРЕПОДАВАТЕЛИ ДЛЯ ЗАМЕНЫ

// Получение списка доступных преподавателей (с коэффициентом)
app.get('/api/teachers/available', Auth.authenticateToken, async (req, res) => {
    try {
        const { date, classes, subject, request_id, applicant, exclude_teacher } = req.query;
        let currentTeacher = req.user.teacher_name;

        if (isAdminUser(req.user)) {
            currentTeacher =
                (applicant && String(applicant).trim()) ||
                (exclude_teacher && String(exclude_teacher).trim()) ||
                (req.query.teacher && String(req.query.teacher).trim()) ||
                null;

            if (!currentTeacher && request_id) {
                const requestRow = await pool.query(
                    'SELECT teacher_name FROM replacement_requests WHERE id = $1',
                    [request_id]
                );
                currentTeacher = requestRow.rows[0]?.teacher_name || null;
            }

            if (currentTeacher === ADMIN_TEACHER_NAME) {
                currentTeacher = null;
            }
        }

        console.log('🔍 Поиск доступных преподавателей:', { date, classes, subject, currentTeacher });
        
        if (!date || !classes || !subject) {
            return res.status(400).json({
                success: false,
                message: 'Необходимы параметры: date, classes, subject'
            });
        }
        
        if (!currentTeacher) {
            return res.status(400).json({
                success: false,
                message: req.user.role === 'admin'
                    ? 'Укажите request_id или applicant (заявитель) для подбора замещающего'
                    : 'Пользователь не связан с преподавателем'
            });
        }
        
        // Получаем всех преподавателей, кроме текущего
        // Сначала проверяем, кто уже занят в это время
        const busyTeachers = await pool.query(
            `SELECT DISTINCT teacher 
             FROM timetable 
             WHERE date = $1 AND classes = $2`,
            [date, parseInt(classes)]
        );

        
        const busyTeacherNames = busyTeachers.rows.map(row => row.teacher);
        console.log('🚫 Занятые преподаватели:', busyTeacherNames);

        const lessonMetaResult = await pool.query(
            `SELECT type
             FROM timetable
             WHERE teacher = $1 AND date = $2 AND classes = $3 AND subject = $4
             ORDER BY is_replacement ASC
             LIMIT 1`,
            [currentTeacher, date, parseInt(classes, 10), subject]
        );
        const lessonType = mapLessonTypeToCompetency(lessonMetaResult.rows[0]?.type);
        const { countsByTeacher, maxCount } = await fetchLessonCountsByTeacher(pool, subject, lessonType);

        const teachersQuery = `
            SELECT 
                t.name,
                t.email,
                t.phone,
                CASE 
                    WHEN t.name = ANY($1) THEN false
                    ELSE true
                END as is_available
            FROM teachers t
            WHERE t.name != $2
              AND t.name != $3
            ORDER BY t.name
        `;
        
        const teachersResult = await pool.query(
            teachersQuery,
            [busyTeacherNames, currentTeacher, ADMIN_TEACHER_NAME]
        );
        
        console.log(`👨‍🏫 Найдено преподавателей: ${teachersResult.rows.length}`);
        
        const teachersWithCoefficient = teachersResult.rows.map((teacher) => {
            if (!teacher.is_available) {
                return {
                    name: teacher.name,
                    email: teacher.email,
                    phone: teacher.phone,
                    coefficient: 0,
                    is_available: false,
                    reason: 'Занят в это время',
                    lesson_count: countsByTeacher.get(teacher.name) || 0
                };
            }

            const competency = buildTeacherCompetency(teacher.name, countsByTeacher, maxCount);

            return {
                name: teacher.name,
                email: teacher.email,
                phone: teacher.phone,
                coefficient: competency.coefficient,
                is_available: true,
                lesson_count: competency.lesson_count,
                max_lesson_count: competency.max_lesson_count
            };
        });
        
        // Сортируем по коэффициенту (по убыванию)
        const sortedTeachers = teachersWithCoefficient
            .filter(teacher => teacher.is_available)
            .sort((a, b) => b.coefficient - a.coefficient);
        
        const busyTeachersList = teachersWithCoefficient
            .filter(teacher => !teacher.is_available);
        
        const allTeachers = [...sortedTeachers, ...busyTeachersList];
        
        console.log(`📊 Доступно преподавателей: ${sortedTeachers.length}`);
        
        res.json({
            success: true,
            teachers: allTeachers,
            available_count: sortedTeachers.length,
            busy_count: busyTeachersList.length,
            search_params: {
                date,
                classes,
                subject,
                current_teacher: currentTeacher,
                lesson_type: lessonType
            }
        });
        
    } catch (error) {
        console.error('❌ Ошибка при получении преподавателей:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});


// Получение списка всех предметов
app.get('/api/subjects', Auth.authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT DISTINCT subject FROM timetable ORDER BY subject`
        );
        const subjects = result.rows.map(row => row.subject);
        res.json({ success: true, subjects });
    } catch (error) {
        console.error('❌ Ошибка при получении предметов:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/schedule/my-classes', Auth.authenticateToken, async (req, res) => {
    try {
        const { date } = req.query;
        const resolved = await resolveEffectiveTeacher(req, {
            queryTeacher: req.query.teacher,
            adminMessage: 'Выберите преподавателя, от имени которого создаётся заявка'
        });

        if (resolved.error) {
            return res.status(400).json({ success: false, message: resolved.error });
        }

        const teacherName = resolved.teacherName;

        if (!date) {
            return res.status(400).json({
                success: false,
                message: 'Необходим параметр: date'
            });
        }

        const result = await pool.query(
            `SELECT DISTINCT classes, dinner, audiense, type
             FROM timetable
             WHERE teacher = $1 AND date = $2
             ORDER BY classes`,
            [teacherName, date]
        );

        const metaResult = await pool.query(
            `SELECT week_num, num_den
             FROM timetable
             WHERE teacher = $1 AND date = $2
             LIMIT 1`,
            [teacherName, date]
        );

        const meta = metaResult.rows[0]
            ? resolveLessonMeta(metaResult.rows[0].week_num, metaResult.rows[0].num_den, date)
            : { week_num: null, num_den: null };

        res.json({
            success: true,
            classes: result.rows.map((row) => ({
                classes: row.classes,
                dinner: row.dinner || null,
                audiense: row.audiense || null,
                type: row.type || null
            })),
            week_num: meta.week_num,
            num_den: meta.num_den
        });
    } catch (error) {
        console.error('❌ Ошибка при получении пар:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/schedule/my-lesson', Auth.authenticateToken, async (req, res) => {
    try {
        const { date, classes } = req.query;
        const resolved = await resolveEffectiveTeacher(req, {
            queryTeacher: req.query.teacher,
            adminMessage: 'Выберите преподавателя, от имени которого создаётся заявка'
        });

        if (resolved.error) {
            return res.status(400).json({ success: false, message: resolved.error });
        }

        const teacherName = resolved.teacherName;

        if (!date || !classes) {
            return res.status(400).json({
                success: false,
                message: 'Необходимы параметры: date, classes'
            });
        }

        const result = await pool.query(
            `SELECT subject, team, week_num, num_den, dinner, audiense, type
             FROM timetable
             WHERE teacher = $1 AND date = $2 AND classes = $3
             LIMIT 1`,
            [teacherName, date, parseInt(classes, 10)]
        );

        if (result.rows.length === 0) {
            return res.json({ success: true, lesson: null });
        }

        const row = result.rows[0];
        const meta = resolveLessonMeta(row.week_num, row.num_den, date);

        res.json({
            success: true,
            lesson: {
                subject: row.subject,
                team: row.team,
                week_num: meta.week_num,
                num_den: meta.num_den,
                num_den_text: meta.num_den === 'den' ? 'знаменатель' : 'числитель',
                dinner: row.dinner || null,
                audiense: row.audiense || null,
                type: row.type || null
            }
        });
    } catch (error) {
        console.error('❌ Ошибка при получении занятия:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/subjects/by-lesson', Auth.authenticateToken, async (req, res) => {
    try {
        const { date, classes } = req.query;
        const teacherName = req.user.teacher_name;
        
        if (!teacherName) {
            return res.status(400).json({
                success: false,
                message: 'Пользователь не связан с преподавателем'
            });
        }
        
        if (!date || !classes) {
            return res.status(400).json({
                success: false,
                message: 'Необходимы параметры: date, classes'
            });
        }
        
        const result = await pool.query(
            `SELECT DISTINCT subject 
             FROM timetable 
             WHERE teacher = $1 AND date = $2 AND classes = $3
             ORDER BY subject`,
            [teacherName, date, parseInt(classes)]
        );
        
        const subjects = result.rows.map(row => row.subject);
        
        res.json({
            success: true,
            subjects: subjects,
            has_schedule: subjects.length > 0
        });
        
    } catch (error) {
        console.error('❌ Ошибка при получении предметов по уроку:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

app.get('/api/schedule/my-teams', Auth.authenticateToken, async (req, res) => {
    try {
        const { date, classes, subject } = req.query;
        const teacherName = req.user.teacher_name;

        if (!teacherName) {
            return res.status(400).json({
                success: false,
                message: 'Пользователь не связан с преподавателем'
            });
        }

        if (!date || !classes || !subject) {
            return res.status(400).json({
                success: false,
                message: 'Необходимы параметры: date, classes, subject'
            });
        }

        const result = await pool.query(
            `SELECT DISTINCT team, week_num, num_den
             FROM timetable
             WHERE teacher = $1 AND date = $2 AND classes = $3 AND subject = $4
             ORDER BY team`,
            [teacherName, date, parseInt(classes), subject]
        );

        res.json({
            success: true,
            teams: result.rows
        });
    } catch (error) {
        console.error('❌ Ошибка при получении групп:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ЗАЯВКИ НА ЗАМЕНУ (Мои заявки / Новая заявка)

// Мои заявки
app.get('/api/requests/my', Auth.authenticateToken, async (req, res) => {
    try {
        const teacherName = req.user.teacher_name;
        const role = req.user.role;
        const userEmail = req.user.email;

        console.log('📋 Запрос заявок от:', { teacherName, role, userEmail });

        let query = '';
        let params = [];

        if (role === 'admin' && !teacherName) {
            const filters = buildAdminListFilters(req.query);
            if (filters.error) {
                return res.status(400).json({ success: false, message: filters.error });
            }

            const whereClause = filters.conditions.length
                ? `WHERE ${filters.conditions.join(' AND ')}`
                : '';

            query = `
                SELECT 
                    r.id,
                    r.teacher_name,
                    r.request_date,
                    r.week_num,
                    r.num_den,
                    CASE r.num_den
                        WHEN 'num' THEN 'числитель'
                        WHEN 'den' THEN 'знаменатель'
                    END as num_den_text,
                    r.classes,
                    r.subject,
                    r.team,
                    r.status,
                    r.replacing_teacher,
                    r.admin_comment,
                    r.created_at,
                    r.updated_at,
                    lesson_meta.audiense,
                    lesson_meta.type,
                    'owner' as request_type
                FROM replacement_requests r
                ${LESSON_META_LATERAL_JOIN}
                ${whereClause}
                ORDER BY r.created_at DESC
            `;
            params = filters.params;
        } else if (teacherName) {
            // Преподаватель видит:
            // 1. Свои заявки (которые он создал)
            // 2. Заявки где его выбрали для замены
            query = `
                SELECT 
                    r.id,
                    r.teacher_name,
                    r.request_date,
                    r.week_num,
                    r.num_den,
                    CASE r.num_den
                        WHEN 'num' THEN 'числитель'
                        WHEN 'den' THEN 'знаменатель'
                    END as num_den_text,
                    r.classes,
                    r.subject,
                    r.team,
                    r.status,
                    r.replacing_teacher,
                    r.admin_comment,
                    r.created_at,
                    r.updated_at,
                    lesson_meta.audiense,
                    lesson_meta.type,
                    CASE 
                        WHEN r.teacher_name = $1 THEN 'owner'
                        WHEN r.replacing_teacher = $1 THEN 'replacement'
                    END as request_type
                FROM replacement_requests r
                ${LESSON_META_LATERAL_JOIN}
                WHERE r.teacher_name = $1 OR r.replacing_teacher = $1
                ORDER BY r.created_at DESC
            `;
            params = [teacherName];
        } else {
            return res.status(400).json({ 
                success: false, 
                message: 'Пользователь не связан с преподавателем' 
            });
        }

        const result = await pool.query(query, params);

        console.log(`📋 Найдено заявок: ${result.rows.length}`);

        res.json({
            success: true,
            requests: result.rows
        });

    } catch (error) {
        console.error('❌ Ошибка при получении заявок:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

// Ответ на заявку о замене (принять/отклонить)
app.put('/api/requests/:id/respond', Auth.authenticateToken, async (req, res) => {
    try {
        const requestId = req.params.id;
        const teacherName = req.user.teacher_name;
        const { action } = req.body; // 'accept' или 'reject'
        
        console.log('🔄 Ответ на заявку:', { requestId, teacherName, action });
        
        if (!action || !['accept', 'reject'].includes(action)) {
            return res.status(400).json({
                success: false,
                message: 'Неверное действие. Допустимые значения: accept, reject'
            });
        }
        
        // Получаем детали заявки
        const checkRequest = await pool.query(
            `SELECT teacher_name, replacing_teacher, status, 
                    request_date, classes, subject, team, week_num, num_den
             FROM replacement_requests 
             WHERE id = $1`,
            [requestId]
        );
        
        if (checkRequest.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Заявка не найдена'
            });
        }
        
        const request = checkRequest.rows[0];
        
        // Проверяем, что этого преподавателя выбрали для замены
        if (request.replacing_teacher !== teacherName) {
            return res.status(403).json({
                success: false,
                message: 'Вы не выбраны для замены в этой заявке'
            });
        }
        
        // Проверяем, что заявка еще на рассмотрении
        if (request.status !== 'pending') {
            return res.status(400).json({
                success: false,
                message: 'Нельзя ответить на заявку со статусом: ' + request.status
            });
        }
        
        const client = await pool.connect();
        
        try {
            await client.query('BEGIN');
            
            // Обновляем статус заявки
            const newStatus = action === 'accept' ? 'confirmed' : 'rejected';
            const adminComment = action === 'accept' 
                ? `Преподаватель ${teacherName} согласился на замену`
                : `Преподаватель ${teacherName} отказался от замены`;
            
            await client.query(
                `UPDATE replacement_requests 
                 SET status = $1, 
                     admin_comment = COALESCE(admin_comment || '\n', '') || $2,
                     updated_at = NOW()
                 WHERE id = $3`,
                [newStatus, adminComment, requestId]
            );
            
            if (action === 'accept') {
                await applyReplacementToTimetable(client, request);
            }
            
            await client.query('COMMIT');
            
            console.log(`✅ Заявка ${requestId} ${action === 'accept' ? 'принята' : 'отклонена'} преподавателем ${teacherName}`);
            
            res.json({
                success: true,
                message: `Вы ${action === 'accept' ? 'приняли' : 'отклонили'} заявку на замену`
            });

            notifyInBackground(() =>
                notifyRequestResponded(pool, request, action)
            );
            
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
        
    } catch (error) {
        console.error('❌ Ошибка при ответе на заявку:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

const REQUEST_DETAIL_SELECT = `
    r.id,
    r.teacher_name,
    r.request_date,
    r.week_num,
    r.num_den,
    CASE r.num_den
        WHEN 'num' THEN 'числитель'
        WHEN 'den' THEN 'знаменатель'
    END AS num_den_text,
    r.classes,
    r.subject,
    r.team,
    r.status,
    r.replacing_teacher,
    r.admin_comment,
    r.created_at,
    r.updated_at,
    lesson_meta.audiense,
    lesson_meta.type,
    t_applicant.phone AS teacher_phone,
    t_replacing.phone AS replacing_teacher_phone
`;

async function fetchRequestById(requestId, { role, teacherName }) {
    const accessFilter =
        role !== 'admin'
            ? ' AND (r.teacher_name = $2 OR r.replacing_teacher = $2)'
            : '';
    const params = role !== 'admin' ? [requestId, teacherName] : [requestId];

    const active = await pool.query(
        `SELECT ${REQUEST_DETAIL_SELECT}
         FROM replacement_requests r
         ${LESSON_META_LATERAL_JOIN}
         LEFT JOIN teachers t_applicant ON t_applicant.name = r.teacher_name
         LEFT JOIN teachers t_replacing ON t_replacing.name = r.replacing_teacher
         WHERE r.id = $1${accessFilter}`,
        params
    );
    if (active.rows.length > 0) {
        return { request: active.rows[0], archived: false };
    }

    if (role !== 'admin') {
        return null;
    }

    const archived = await pool.query(
        `SELECT ${REQUEST_DETAIL_SELECT}, r.archived_at
         FROM replacement_requests_archive r
         ${LESSON_META_LATERAL_JOIN}
         LEFT JOIN teachers t_applicant ON t_applicant.name = r.teacher_name
         LEFT JOIN teachers t_replacing ON t_replacing.name = r.replacing_teacher
         WHERE r.id = $1`,
        [requestId]
    );
    if (archived.rows.length === 0) {
        return null;
    }
    return { request: archived.rows[0], archived: true };
}

// Получение деталей конкретной заявки
app.get('/api/requests/:id', Auth.authenticateToken, async (req, res) => {
    try {
        const requestId = req.params.id;
        const found = await fetchRequestById(requestId, {
            role: req.user.role,
            teacherName: req.user.teacher_name
        });

        if (!found) {
            return res.status(404).json({
                success: false,
                message: 'Заявка не найдена или у вас нет прав для просмотра'
            });
        }

        res.json({
            success: true,
            request: found.request,
            archived: found.archived
        });
    } catch (error) {
        console.error('❌ Ошибка при получении деталей заявки:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Создание новой заявки
app.post('/api/requests', Auth.authenticateToken, async (req, res) => {
    try {
        const {
            request_date,
            week_num,
            num_den,
            classes,
            subject,
            team,
            replacing_teacher,
            teacher_name: bodyTeacherName
        } = req.body;

        const resolved = await resolveEffectiveTeacher(req, {
            bodyTeacher: bodyTeacherName,
            adminMessage: 'Укажите преподавателя (teacher_name), от имени которого создаётся заявка'
        });

        if (resolved.error) {
            return res.status(400).json({ success: false, message: resolved.error });
        }

        const teacherName = resolved.teacherName;

        console.log('📝 Создание новой заявки:', {
            teacher: teacherName,
            date: request_date,
            classes,
            subject,
            team,
            replacing_teacher,
            createdBy: req.user.email
        });
        
        if (!request_date || !classes || !subject || !team) {
            return res.status(400).json({
                success: false,
                message: 'Обязательные поля: request_date, classes, subject, team'
            });
        }

        const lessonCheck = await pool.query(
            `SELECT week_num, num_den
             FROM timetable
             WHERE teacher = $1 AND date = $2 AND classes = $3 AND subject = $4 AND team = $5
             LIMIT 1`,
            [teacherName, request_date, classes, subject, team]
        );

        if (lessonCheck.rows.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Занятие не найдено в вашем расписании. Выберите дату, пару, предмет и группу из списков.'
            });
        }

        const lessonFromSchedule = lessonCheck.rows[0];
        const resolvedMeta = resolveLessonMeta(
            lessonFromSchedule.week_num,
            lessonFromSchedule.num_den,
            request_date
        );
        const resolvedWeekNum = resolvedMeta.week_num;
        const resolvedNumDen = resolvedMeta.num_den;
        
        // Проверяем, существует ли выбранный преподаватель (если указан)
        if (replacing_teacher) {
            if (String(replacing_teacher).trim() === ADMIN_TEACHER_NAME) {
                return res.status(400).json({
                    success: false,
                    message: 'Администратор не может быть выбран замещающим преподавателем'
                });
            }

            const teacherCheck = await pool.query(
                'SELECT name FROM teachers WHERE name = $1',
                [replacing_teacher]
            );
            
            if (teacherCheck.rows.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Выбранный преподаватель не найден'
                });
            }
            
            // Проверяем, не занят ли преподаватель в это время
            const busyCheck = await pool.query(
                `SELECT COUNT(*) as count 
                 FROM timetable 
                 WHERE teacher = $1 AND date = $2 AND classes = $3`,
                [replacing_teacher, request_date, classes]
            );
            
            if (parseInt(busyCheck.rows[0].count) > 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Выбранный преподаватель уже занят в это время'
                });
            }
        }
        
        // Проверяем, нет ли уже такой заявки
        const existingRequest = await pool.query(
            `SELECT id FROM replacement_requests 
             WHERE teacher_name = $1 
             AND request_date = $2 
             AND classes = $3 
             AND subject = $4 
             AND status = 'pending'`,
            [teacherName, request_date, classes, subject]
        );
        
        if (existingRequest.rows.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'У вас уже есть активная заявка на эту пару'
            });
        }
        
        // Создаем заявку
        const result = await pool.query(
            `INSERT INTO replacement_requests 
                (teacher_name, request_date, week_num, num_den, classes, subject, team, status, replacing_teacher)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
             RETURNING id`,
            [
                teacherName,
                request_date,
                resolvedWeekNum || null,
                resolvedNumDen || null,
                classes,
                subject,
                team,
                replacing_teacher || null
            ]
        );
        
        const requestId = result.rows[0].id;
        console.log('✅ Заявка создана, ID:', requestId);

        const createdRequest = {
            id: requestId,
            teacher_name: teacherName,
            request_date,
            week_num: resolvedWeekNum,
            num_den: resolvedNumDen,
            classes,
            subject,
            team,
            replacing_teacher
        };
        
         if (replacing_teacher) {
            console.log('📧 ДОЛЖНО ОТПРАВИТЬСЯ ПИСЬМО ДЛЯ:', replacing_teacher);
            notifyInBackground(() =>
                notifyNewReplacementRequest(pool, createdRequest)
            );
        }
        
        res.json({
            success: true,
            message: 'Заявка успешно создана',
            request_id: requestId
        });

        
    } catch (error) {
        console.error('❌ Ошибка при создании заявки:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});



// Отмена заявки
app.put('/api/requests/:id/cancel', Auth.authenticateToken, async (req, res) => {
    try {
        const requestId = req.params.id;
        const teacherName = req.user.teacher_name;
        const role = req.user.role;
        
        console.log('🗑️ Отмена заявки:', { requestId, teacherName, role });
        
        // Проверяем, существует ли заявка
        const checkRequest = await pool.query(
            `SELECT teacher_name, replacing_teacher, request_date, week_num, num_den,
                    classes, subject, team, status
             FROM replacement_requests WHERE id = $1`,
            [requestId]
        );
        
        if (checkRequest.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Заявка не найдена'
            });
        }
        
        const request = checkRequest.rows[0];
        
        // Проверяем права (только владелец или админ)
        if (role !== 'admin' && request.teacher_name !== teacherName) {
            return res.status(403).json({
                success: false,
                message: 'Нет прав для отмены этой заявки'
            });
        }
        
        if (role === 'admin') {
            if (!['pending', 'confirmed'].includes(request.status)) {
                return res.status(400).json({
                    success: false,
                    message: 'Администратор может отменять только заявки «На рассмотрении» или «Подтверждена»'
                });
            }
        } else if (request.status !== 'pending') {
            return res.status(400).json({
                success: false,
                message: 'Можно отменять только заявки со статусом "На рассмотрении"'
            });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            if (role === 'admin' && request.status === 'confirmed') {
                await revertReplacementFromTimetable(client, request);
            }

            const adminNote = request.status === 'confirmed'
                ? 'Подтверждённая заявка отменена администратором'
                : 'Отменено администратором';

            if (role === 'admin') {
                await client.query(
                    `UPDATE replacement_requests 
                     SET status = 'cancelled',
                         updated_at = NOW(),
                         admin_comment = COALESCE(admin_comment || E'\\n', '') || $2
                     WHERE id = $1`,
                    [requestId, adminNote]
                );
            } else {
                await client.query(
                    `UPDATE replacement_requests 
                     SET status = 'cancelled', updated_at = NOW()
                     WHERE id = $1`,
                    [requestId]
                );
            }

            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
        
        console.log('✅ Заявка отменена');

        const cancelledRequest = checkRequest.rows[0];
        
        res.json({
            success: true,
            message: 'Заявка успешно отменена'
        });

        notifyInBackground(() =>
            notifyRequestCancelled(pool, cancelledRequest)
        );
        
    } catch (error) {
        console.error('❌ Ошибка при отмене заявки:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// АДМИНИСТРАТОР

// Подтверждение заявки администратором
app.put('/api/admin/requests/:id/confirm', Auth.authenticateToken, Auth.requireAdmin, async (req, res) => {
    try {
        const requestId = req.params.id;
        const bodyReplacing = req.body?.replacing_teacher
            ? String(req.body.replacing_teacher).trim()
            : null;

        const checkRequest = await pool.query(
            `SELECT id, teacher_name, replacing_teacher, status,
                    request_date, week_num, num_den, classes, subject, team
             FROM replacement_requests WHERE id = $1`,
            [requestId]
        );

        if (checkRequest.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Заявка не найдена'
            });
        }

        const request = checkRequest.rows[0];

        if (request.status !== 'pending') {
            return res.status(400).json({
                success: false,
                message: 'Подтвердить можно только заявки со статусом «На рассмотрении»'
            });
        }

        const replacingTeacher = bodyReplacing || request.replacing_teacher;
        if (!replacingTeacher) {
            return res.status(400).json({
                success: false,
                message: 'Укажите замещающего преподавателя перед подтверждением'
            });
        }

        if (replacingTeacher === ADMIN_TEACHER_NAME) {
            return res.status(400).json({
                success: false,
                message: 'Администратор не может быть назначен замещающим преподавателем'
            });
        }

        const teacherCheck = await pool.query(
            'SELECT name FROM teachers WHERE name = $1',
            [replacingTeacher]
        );
        if (teacherCheck.rows.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Замещающий преподаватель не найден'
            });
        }

        if (replacingTeacher !== request.replacing_teacher) {
            const busyCheck = await pool.query(
                `SELECT COUNT(*)::int AS count 
                 FROM timetable 
                 WHERE teacher = $1 AND date = $2 AND classes = $3`,
                [replacingTeacher, request.request_date, request.classes]
            );
            if (busyCheck.rows[0].count > 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Выбранный преподаватель уже занят в это время'
                });
            }
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            await client.query(
                `UPDATE replacement_requests 
                 SET status = 'confirmed',
                     replacing_teacher = $1,
                     admin_comment = COALESCE(admin_comment || E'\\n', '') || $2,
                     updated_at = NOW()
                 WHERE id = $3`,
                [replacingTeacher, 'Подтверждено администратором', requestId]
            );

            const requestForTimetable = { ...request, replacing_teacher: replacingTeacher };
            await applyReplacementToTimetable(client, requestForTimetable);

            await client.query('COMMIT');

            res.json({
                success: true,
                message: 'Заявка подтверждена'
            });

            notifyInBackground(() =>
                notifyRequestResponded(pool, requestForTimetable, 'accept')
            );
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('❌ Ошибка подтверждения заявки администратором:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// История замен
app.get('/api/admin/replacements-history', Auth.authenticateToken, Auth.requireAdmin, async (req, res) => {
    try {
        const filters = buildAdminListFilters(req.query);
        if (filters.error) {
            return res.status(400).json({ success: false, message: filters.error });
        }

        const conditions = [
            'r.replacing_teacher IS NOT NULL',
            ...filters.conditions
        ];
        const params = [...filters.params];

        // Без фильтра по статусу показываем только состоявшиеся замены
        if (!req.query.status) {
            conditions.push(`r.status = 'confirmed'`);
        }

        const whereClause = `WHERE ${conditions.join(' AND ')}`;

        const query = `
            SELECT 
                r.id AS request_id,
                r.teacher_name AS original_teacher,
                r.replacing_teacher,
                r.request_date AS date,
                r.classes,
                r.subject,
                r.team,
                lesson_meta.audiense,
                lesson_meta.type,
                r.week_num,
                r.num_den,
                CASE r.num_den
                    WHEN 'num' THEN 'числитель'
                    WHEN 'den' THEN 'знаменатель'
                END AS num_den_text,
                r.status AS request_status,
                r.admin_comment,
                r.created_at AS request_created_at,
                r.updated_at AS request_updated_at,
                (
                    SELECT t.teacher
                    FROM timetable t
                    WHERE t.date = r.request_date
                      AND t.classes = r.classes
                      AND t.subject = r.subject
                      AND t.teacher = r.teacher_name
                      AND t.is_replacement = true
                    LIMIT 1
                ) AS timetable_teacher
            FROM replacement_requests r
            ${LESSON_META_LATERAL_JOIN}
            ${whereClause}
            ORDER BY r.request_date DESC, r.classes ASC, r.id DESC
        `;

        const result = await pool.query(query, params);

        res.json({
            success: true,
            count: result.rows.length,
            filters: {
                from: req.query.from || null,
                to: req.query.to || null,
                status: req.query.status || null,
                teacher: req.query.teacher || null
            },
            history: result.rows
        });
    } catch (error) {
        console.error('❌ Ошибка /api/admin/replacements-history:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Запуск очистки/архивации вручную (также вызывается при загрузке панели админа)
app.post('/api/admin/requests/maintenance', Auth.authenticateToken, Auth.requireAdmin, async (req, res) => {
    try {
        await ensureArchiveSchema(pool);
        const result = await runRequestRetention(pool);
        res.json({
            success: true,
            retention_months: REQUEST_RETENTION_MONTHS,
            archived: result.archived,
            deleted_cancelled: result.deletedCancelled
        });
    } catch (error) {
        console.error('❌ Ошибка maintenance заявок:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Архив подтверждённых заявок (старше 6 месяцев переносятся автоматически)
app.get('/api/admin/requests/archive', Auth.authenticateToken, Auth.requireAdmin, async (req, res) => {
    try {
        const filters = buildAdminListFilters(req.query);
        if (filters.error) {
            return res.status(400).json({ success: false, message: filters.error });
        }

        const whereClause = filters.conditions.length
            ? `WHERE ${filters.conditions.join(' AND ')}`
            : '';

        const result = await pool.query(
            `SELECT
                r.id,
                r.teacher_name,
                r.request_date,
                r.week_num,
                r.num_den,
                CASE r.num_den
                    WHEN 'num' THEN 'числитель'
                    WHEN 'den' THEN 'знаменатель'
                END AS num_den_text,
                r.classes,
                r.subject,
                r.team,
                r.status,
                r.replacing_teacher,
                r.admin_comment,
                r.created_at,
                r.updated_at,
                r.archived_at,
                lesson_meta.audiense,
                lesson_meta.type,
                t_applicant.phone AS teacher_phone,
                t_replacing.phone AS replacing_teacher_phone
             FROM replacement_requests_archive r
             ${LESSON_META_LATERAL_JOIN}
             LEFT JOIN teachers t_applicant ON t_applicant.name = r.teacher_name
             LEFT JOIN teachers t_replacing ON t_replacing.name = r.replacing_teacher
             ${whereClause}
             ORDER BY r.archived_at DESC, r.created_at DESC`,
            filters.params
        );

        res.json({
            success: true,
            count: result.rows.length,
            retention_months: REQUEST_RETENTION_MONTHS,
            requests: result.rows
        });
    } catch (error) {
        console.error('❌ Ошибка /api/admin/requests/archive:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Удаление отменённой заявки (только если ещё не подлежит автоудалению)
app.delete('/api/admin/requests/:id', Auth.authenticateToken, Auth.requireAdmin, async (req, res) => {
    try {
        const requestId = req.params.id;
        const cutoff = getRetentionCutoffSql();

        const result = await pool.query(
            `DELETE FROM replacement_requests
             WHERE id = $1
               AND status = 'cancelled'
               AND request_date >= ${cutoff}
             RETURNING id`,
            [requestId]
        );

        if (result.rowCount === 0) {
            const existing = await pool.query(
                'SELECT status, created_at FROM replacement_requests WHERE id = $1',
                [requestId]
            );
            if (existing.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Заявка не найдена'
                });
            }
            const row = existing.rows[0];
            if (row.status !== 'cancelled') {
                return res.status(400).json({
                    success: false,
                    message: 'Удалять можно только отменённые заявки'
                });
            }
            return res.status(400).json({
                success: false,
                message: `Отменённые заявки старше ${REQUEST_RETENTION_MONTHS} мес. удаляются автоматически`
            });
        }

        res.json({
            success: true,
            message: 'Заявка удалена'
        });
    } catch (error) {
        console.error('❌ Ошибка удаления заявки:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Все заявки с фильтрами 
app.get('/api/admin/requests', Auth.authenticateToken, Auth.requireAdmin, async (req, res) => {
    try {
        const filters = buildAdminListFilters(req.query);
        if (filters.error) {
            return res.status(400).json({ success: false, message: filters.error });
        }

        const whereClause = filters.conditions.length
            ? `WHERE ${filters.conditions.join(' AND ')}`
            : '';

        const result = await pool.query(
            `SELECT 
                r.id,
                r.teacher_name,
                r.request_date,
                r.week_num,
                r.num_den,
                CASE r.num_den
                    WHEN 'num' THEN 'числитель'
                    WHEN 'den' THEN 'знаменатель'
                END AS num_den_text,
                r.classes,
                r.subject,
                r.team,
                r.status,
                r.replacing_teacher,
                r.admin_comment,
                r.created_at,
                r.updated_at,
                lesson_meta.audiense,
                lesson_meta.type,
                t_applicant.phone AS teacher_phone,
                t_replacing.phone AS replacing_teacher_phone
             FROM replacement_requests r
             ${LESSON_META_LATERAL_JOIN}
             LEFT JOIN teachers t_applicant ON t_applicant.name = r.teacher_name
             LEFT JOIN teachers t_replacing ON t_replacing.name = r.replacing_teacher
             ${whereClause}
             ORDER BY r.created_at DESC`,
            filters.params
        );

        res.json({
            success: true,
            count: result.rows.length,
            retention_months: REQUEST_RETENTION_MONTHS,
            filters: {
                from: req.query.from || null,
                to: req.query.to || null,
                status: req.query.status || null,
                teacher: req.query.teacher || null
            },
            requests: result.rows
        });
    } catch (error) {
        console.error('❌ Ошибка /api/admin/requests:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// ПРОФИЛЬ

app.get('/api/profile', Auth.authenticateToken, async (req, res) => {
    try {
        const result = await Auth.getCurrentUser(req.user.email);
        if (!result.success) {
            return res.status(404).json(result);
        }
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/profile', Auth.authenticateToken, async (req, res) => {
    try {
        const result = await Auth.updateProfile(req.user.email, req.body || {});
        if (!result.success) {
            const status = result.message.includes('не найден') ? 404 : 400;
            return res.status(status).json(result);
        }
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Обработчик 404 для API маршрутов
app.use('/api/*', (req, res) => {
    console.log(`❌ API маршрут не найден: ${req.originalUrl}`);
    res.status(404).json({
        success: false,
        error: 'API endpoint not found',
        message: `Маршрут ${req.originalUrl} не существует`,
        timestamp: new Date().toISOString()
    });
});

// ФРОНТЕНД МАРШРУТЫ

// Главная страница (вход)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Страница dashboard
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Любой другой маршрут
app.get('*', (req, res) => {
    res.status(404).send('Страница не найдена');
});

// ЗАПУСК СЕРВЕРА

/** Восстановление имён после старой логики teacher || ' → ' || replacer */
async function repairCorruptedTimetableTeachers() {
    try {
        const result = await pool.query(`
            UPDATE timetable
            SET teacher = TRIM(SPLIT_PART(teacher, ' → ', 1))
            WHERE teacher LIKE '% → %'
        `);
        if (result.rowCount > 0) {
            console.log(`🔧 Восстановлено имён в timetable: ${result.rowCount} записей`);
        }
    } catch (error) {
        console.warn('⚠️ Не удалось восстановить поле teacher в timetable:', error.message);
    }
}

const startServer = async () => {
    try {
        console.log('🔧 Запуск сервера замены преподавателей...');
        
        // Проверка базы данных
        console.log('🔍 Проверка подключения к PostgreSQL...');
        const dbConnected = await testConnection();
        
        if (!dbConnected) {
            console.error('❌ Ошибка подключения к базе данных!');
            console.error('💡 Запустите PostgreSQL (docker compose up -d) и проверьте DB_PASSWORD в .env');
        } else {
            console.log('✅ База данных подключена успешно!');
            await bootstrapDatabase();
            await ensureArchiveSchema(pool);
            await runRequestRetention(pool);
            scheduleRequestRetention(pool);
            await repairCorruptedTimetableTeachers();
            await ensureScheduleLoaded(pool);
        }

        if (isEmailEnabled()) {
            console.log('📧 Email-уведомления: включены (SMTP)');
        } else {
            console.log('📧 Email-уведомления: выключены (EMAIL_ENABLED=false)');
        }
        
        // Запуск сервера
        const server = app.listen(PORT, () => {
            console.log(`\n🚀 СЕРВЕР ЗАПУЩЕН!`);
            console.log(`=========================================`);
            console.log(`📡 Порт: ${PORT}`);
            console.log(`\n📌 ОСНОВНЫЕ ССЫЛКИ:`);
            console.log(`   🔗 Главная страница: http://localhost:${PORT}`);
            console.log(`   🔗 Панель управления: http://localhost:${PORT}/dashboard`);
            console.log(`   🔗 Проверка сервера: http://localhost:${PORT}/api/health`);
            console.log(`   🔗 Тест расписания: http://localhost:${PORT}/api/test-schedule`);
            console.log(`\n👥 ТЕСТОВЫЕ ПОЛЬЗОВАТЕЛИ:`);
            console.log(`   👨‍🏫 Преподаватель: milehina@university.ru (пароль teacher123)`);
            console.log(`   👨‍💼 Администратор: admin@university.ru (пароль admin123)`);
            console.log(`\n⚡ ДЛЯ ОСТАНОВКИ СЕРВЕРА: Ctrl+C`);
            console.log(`=========================================`);
        });

        server.on('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                console.error(`❌ Порт ${PORT} уже занят. Остановите другой процесс или задайте другой PORT в .env`);
            } else {
                console.error('❌ Ошибка запуска HTTP-сервера:', error.message);
            }
            process.exit(1);
        });
        
    } catch (error) {
        console.error('❌ Ошибка запуска сервера:', error);
        process.exit(1);
    }
};

// Запускаем сервер
startServer();
