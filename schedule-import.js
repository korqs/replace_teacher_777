const fs = require('fs');
const path = require('path');

const DEFAULT_CSV_PATH = path.join(__dirname, 'data', 'schedule.csv');
const CYRILLIC_RE = /[а-яА-ЯёЁ]/;

function readCsvFileContent(filePath) {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
        throw new Error(`CSV файл не найден: ${resolved}`);
    }

    const forcedEncoding = String(process.env.SCHEDULE_CSV_ENCODING || 'auto').trim().toLowerCase();
    const buf = fs.readFileSync(resolved);

    if (forcedEncoding === 'utf8' || forcedEncoding === 'utf-8') {
        return stripBom(buf.toString('utf8'));
    }
    if (forcedEncoding === 'cp1251' || forcedEncoding === 'windows-1251') {
        return decodeWindows1251(buf);
    }

    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
        const text = stripBom(buf.slice(3).toString('utf8'));
        if (looksLikeScheduleCsv(text)) {
            console.log(`📄 CSV: UTF-8 с BOM (${resolved})`);
            return text;
        }
    }

    const asUtf8 = stripBom(buf.toString('utf8'));
    if (looksLikeScheduleCsv(asUtf8)) {
        console.log(`📄 CSV: UTF-8 (${resolved})`);
        return asUtf8;
    }

    const asWin1251 = decodeWindows1251(buf);
    if (looksLikeScheduleCsv(asWin1251)) {
        console.log(`📄 CSV: Windows-1251 (${resolved})`);
        return asWin1251;
    }

    console.warn(`⚠️  Не удалось определить кодировку CSV, используем UTF-8: ${resolved}`);
    return asUtf8;
}

function stripBom(text) {
    return text.replace(/^\uFEFF/, '');
}

function decodeWindows1251(buf) {
    return new TextDecoder('windows-1251').decode(buf);
}

function looksLikeScheduleCsv(text) {
    const firstLine = text.split(/\r?\n/).find((line) => line.trim() && !line.trim().startsWith('#'));
    if (!firstLine) {
        return false;
    }
    if (firstLine.includes('\uFFFD')) {
        return false;
    }
    const headers = parseCsvLine(firstLine).map((h) => h.toLowerCase());
    const hasRequiredHeaders = REQUIRED_COLUMNS.every((col) => headers.includes(col));
    if (!hasRequiredHeaders) {
        return false;
    }
    const sampleLine = text.split(/\r?\n/).find((line, idx) => idx > 0 && line.trim() && !line.trim().startsWith('#'));
    if (!sampleLine || sampleLine.includes('\uFFFD')) {
        return hasRequiredHeaders;
    }
    return CYRILLIC_RE.test(sampleLine) || !/[?]{3,}/.test(sampleLine);
}

const REQUIRED_COLUMNS = ['subject', 'classes', 'team', 'teacher', 'date'];
const OPTIONAL_COLUMNS = ['dinner', 'week_num', 'num_den', 'type', 'audiense', 'audience'];
const VALID_TYPES = ['лекция', 'семинар', 'лабораторная работа'];
const VALID_DINNER = ['predlunch', 'postlunch'];
const VALID_NUM_DEN = ['num', 'den'];
const NUM_DEN_ALIASES = {
    num: 'num',
    den: 'den',
    числитель: 'num',
    знаменатель: 'den'
};

function parseCsvLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            fields.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    fields.push(current);
    return fields.map((f) => f.trim());
}

function parseCsvContent(content) {
    const text = content.replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#'));

    if (lines.length < 2) {
        throw new Error('CSV пуст или содержит только заголовок');
    }

    const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
    const rows = [];

    for (let i = 1; i < lines.length; i++) {
        const values = parseCsvLine(lines[i]);
        if (values.every((v) => !v)) continue;

        const row = {};
        headers.forEach((header, idx) => {
            row[header] = values[idx] ?? '';
        });
        rows.push(row);
    }

    return rows;
}

function getDayOfWeek(dateStr) {
    const d = new Date(`${dateStr}T12:00:00`);
    if (Number.isNaN(d.getTime())) {
        throw new Error(`Некорректная дата: ${dateStr}`);
    }
    return d.getDay();
}

function getIsoWeekNumber(dateStr) {
    const d = new Date(`${dateStr}T12:00:00`);
    const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = target.getUTCDay() || 7;
    target.setUTCDate(target.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
    return Math.ceil((((target - yearStart) / 86400000) + 1) / 7);
}

function normalizeNumDen(value) {
    const key = String(value ?? '').trim().toLowerCase();
    if (NUM_DEN_ALIASES[key]) return NUM_DEN_ALIASES[key];
    return VALID_NUM_DEN.includes(key) ? key : null;
}

/** Нечётная неделя — числитель, чётная — знаменатель */
function numDenFromWeekNum(weekNum) {
    const week = parseInt(weekNum, 10);
    if (!Number.isInteger(week)) return null;
    return week % 2 === 1 ? 'num' : 'den';
}

function resolveLessonMeta(weekNum, numDen, dateStr) {
    let week = parseInt(weekNum, 10);
    if (!Number.isInteger(week) || week < 1) {
        week = dateStr ? getIsoWeekNumber(dateStr) : null;
    }

    let resolvedNumDen = null;
    if (Number.isInteger(week) && week > 0) {
        resolvedNumDen = numDenFromWeekNum(week);
    } else {
        resolvedNumDen = normalizeNumDen(numDen);
        if (!resolvedNumDen && dateStr) {
            resolvedNumDen = getIsoWeekNumber(dateStr) % 2 === 0 ? 'den' : 'num';
        }
    }

    return {
        week_num: Number.isInteger(week) && week > 0 ? week : null,
        num_den: resolvedNumDen
    };
}

function normalizeRow(raw, lineNum) {
    const missing = REQUIRED_COLUMNS.filter((col) => !String(raw[col] ?? '').trim());
    if (missing.length) {
        throw new Error(`Строка ${lineNum}: не заполнены поля ${missing.join(', ')}`);
    }

    const dateMatch = String(raw.date).trim().match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) {
        throw new Error(`Строка ${lineNum}: дата должна быть в формате YYYY-MM-DD`);
    }

    const classes = parseInt(raw.classes, 10);
    if (!Number.isInteger(classes) || classes < 1 || classes > 8) {
        throw new Error(`Строка ${lineNum}: номер пары должен быть от 1 до 8`);
    }

    const dinner = String(raw.dinner ?? '').trim() || null;
    if (dinner && !VALID_DINNER.includes(dinner)) {
        throw new Error(`Строка ${lineNum}: dinner должен быть predlunch, postlunch или пустым`);
    }

    let numDen = NUM_DEN_ALIASES[String(raw.num_den ?? '').trim().toLowerCase()];
    if (!numDen) {
        numDen = getIsoWeekNumber(dateMatch[1]) % 2 === 0 ? 'den' : 'num';
    }
    if (!VALID_NUM_DEN.includes(numDen)) {
        throw new Error(`Строка ${lineNum}: num_den должен быть num, den, числитель или знаменатель`);
    }

    let weekNum = parseInt(raw.week_num, 10);
    if (!Number.isInteger(weekNum) || weekNum < 1) {
        weekNum = getIsoWeekNumber(dateMatch[1]);
    }

    const audiense = String(raw.audiense ?? raw.audience ?? '').trim() || null;
    const lessonType = String(raw.type ?? '').trim().toLowerCase() || null;
    if (lessonType && !VALID_TYPES.includes(lessonType)) {
        throw new Error(`Строка ${lineNum}: type должен быть лекция, семинар или лабораторная работа`);
    }

    return {
        subject: String(raw.subject).trim(),
        classes,
        dinner,
        team: String(raw.team).trim(),
        teacher: String(raw.teacher).trim(),
        date: dateMatch[1],
        day_of_week: getDayOfWeek(dateMatch[1]),
        week_num: weekNum,
        num_den: numDen,
        audiense,
        type: lessonType
    };
}

function parseScheduleCsv(filePath = DEFAULT_CSV_PATH) {
    const content = readCsvFileContent(filePath);
    const rawRows = parseCsvContent(content);

    return rawRows.map((row, idx) => normalizeRow(row, idx + 2));
}

async function ensureTimetableColumns(client) {
    await client.query('ALTER TABLE timetable ADD COLUMN IF NOT EXISTS audiense TEXT');
    await client.query('ALTER TABLE timetable ADD COLUMN IF NOT EXISTS type TEXT');
}

async function importScheduleFromCsv(pool, options = {}) {
    const filePath = options.filePath || process.env.SCHEDULE_CSV || DEFAULT_CSV_PATH;
    const replace = options.replace !== false;

    const rows = parseScheduleCsv(filePath);
    if (rows.length === 0) {
        return { imported: 0, skipped: 0, file: filePath };
    }

    const client = options.client || await pool.connect();
    const ownClient = !options.client;

    try {
        if (ownClient) await client.query('BEGIN');

        await ensureTimetableColumns(client);

        if (replace) {
            await client.query('DELETE FROM timetable WHERE is_replacement = false');
        }

        const teachersResult = await client.query('SELECT name FROM teachers');
        const knownTeachers = new Set(teachersResult.rows.map((r) => r.name));

        let imported = 0;
        let skipped = 0;

        for (const row of rows) {
            if (!knownTeachers.has(row.teacher)) {
                skipped++;
                console.warn(`⚠️  Пропуск: преподаватель «${row.teacher}» не найден в справочнике teachers`);
                continue;
            }

            await client.query(
                `INSERT INTO timetable
                    (subject, classes, dinner, team, teacher, date, day_of_week, week_num, num_den, audiense, type, is_replacement)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false)`,
                [
                    row.subject,
                    row.classes,
                    row.dinner,
                    row.team,
                    row.teacher,
                    row.date,
                    row.day_of_week,
                    row.week_num,
                    row.num_den,
                    row.audiense,
                    row.type
                ]
            );
            imported++;
        }

        if (ownClient) await client.query('COMMIT');

        return { imported, skipped, total: rows.length, file: path.resolve(filePath) };
    } catch (error) {
        if (ownClient) await client.query('ROLLBACK');
        throw error;
    } finally {
        if (ownClient) client.release();
    }
}

async function isTimetableCorrupted(pool) {
    const result = await pool.query(`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (
                   WHERE subject LIKE '%?%'
                      OR team LIKE '%?%'
                      OR teacher LIKE '%?%'
               )::int AS broken
        FROM timetable
    `);
    const { total, broken } = result.rows[0];
    return total > 0 && broken > 0;
}

/**
 * Колонки type/audiense появились позже основной схемы, поэтому в базах,
 * заполненных до этого, они остаются пустыми: ALTER TABLE их только добавляет.
 */
async function isTimetableMissingLessonMeta(pool) {
    const result = await pool.query(`
        SELECT COUNT(*)::int AS total,
               COUNT(type)::int AS with_type
        FROM timetable
        WHERE is_replacement = false
    `);
    const { total, with_type: withType } = result.rows[0];
    return total > 0 && withType === 0;
}

/** Занятия-замены наследуют тип и аудиторию исходного занятия */
async function backfillReplacementLessonMeta(pool) {
    const result = await pool.query(`
        UPDATE timetable r
        SET audiense = COALESCE(r.audiense, o.audiense),
            type = COALESCE(r.type, o.type)
        FROM timetable o
        WHERE r.is_replacement = true
          AND o.is_replacement = false
          AND o.date = r.date
          AND o.classes = r.classes
          AND o.subject = r.subject
          AND o.team = r.team
          AND (r.type IS NULL OR r.audiense IS NULL)
          AND (o.type IS NOT NULL OR o.audiense IS NOT NULL)
    `);
    return result.rowCount;
}

async function ensureScheduleLoaded(pool) {
    const csvPath = process.env.SCHEDULE_CSV || DEFAULT_CSV_PATH;
    const resolvedCsvPath = path.resolve(csvPath);

    if (!fs.existsSync(resolvedCsvPath)) {
        console.warn(`⚠️  CSV не найден: ${resolvedCsvPath}`);
        return null;
    }

    const countResult = await pool.query('SELECT COUNT(*)::int AS count FROM timetable');
    const isEmpty = countResult.rows[0].count === 0;
    const corrupted = !isEmpty && await isTimetableCorrupted(pool);
    let missingMeta = false;

    if (!isEmpty && !corrupted && await isTimetableMissingLessonMeta(pool)) {
        // Перезалив имеет смысл только если тип занятия есть в самом CSV
        try {
            missingMeta = parseScheduleCsv(resolvedCsvPath).some((row) => row.type);
        } catch (error) {
            console.warn(`⚠️  Не удалось прочитать CSV для проверки типов занятий: ${error.message}`);
        }

        if (!missingMeta) {
            console.warn('⚠️  У занятий не заполнен тип (лекция/семинар), и в CSV его тоже нет');
        }
    }

    if (!isEmpty && !corrupted && !missingMeta) {
        await reportReplacementMetaBackfill(pool);
        return null;
    }

    if (corrupted) {
        console.log('⚠️  В расписании битая кириллица (???) — повторный импорт из CSV');
    } else if (missingMeta) {
        console.log('⚠️  У занятий не заполнен тип (лекция/семинар) — повторный импорт из CSV');
    } else {
        console.log(`📅 Расписание пусто — загрузка из ${resolvedCsvPath}`);
    }

    const result = await importScheduleFromCsv(pool, { filePath: resolvedCsvPath, replace: true });
    console.log(`✅ Импортировано занятий: ${result.imported}`);
    if (result.skipped > 0) {
        console.log(`⚠️  Пропущено строк: ${result.skipped} (преподаватель не найден в справочнике)`);
    }
    await reportReplacementMetaBackfill(pool);
    return result;
}

async function reportReplacementMetaBackfill(pool) {
    try {
        const updated = await backfillReplacementLessonMeta(pool);
        if (updated > 0) {
            console.log(`🔧 Тип и аудитория проставлены у замен: ${updated} записей`);
        }
    } catch (error) {
        console.warn('⚠️ Не удалось заполнить тип/аудиторию у замен:', error.message);
    }
}

module.exports = {
    DEFAULT_CSV_PATH,
    readCsvFileContent,
    parseScheduleCsv,
    importScheduleFromCsv,
    ensureScheduleLoaded,
    isTimetableCorrupted,
    isTimetableMissingLessonMeta,
    backfillReplacementLessonMeta,
    getDayOfWeek,
    getIsoWeekNumber,
    normalizeNumDen,
    resolveLessonMeta
};

if (require.main === module) {
    const { pool } = require('./init_db');

    (async () => {
        try {
            const replace = process.argv.includes('--append') ? false : true;
            const fileArg = process.argv.find((a) => a.startsWith('--file='));
            const filePath = fileArg ? fileArg.slice('--file='.length) : undefined;

            console.log('📖 Импорт расписания из CSV...');
            const result = await importScheduleFromCsv(pool, { filePath, replace });
            console.log(`✅ Готово: ${result.imported} записей (${result.skipped} пропущено)`);
            console.log(`   Файл: ${result.file}`);
            process.exit(0);
        } catch (error) {
            console.error('❌ Ошибка импорта:', error.message);
            if (/password authentication failed/i.test(error.message)) {
                console.error('');
                console.error('💡 Неверный пароль PostgreSQL. Проверьте DB_PASSWORD в файле .env');
                console.error('   Убедитесь, что PostgreSQL запущен и база teacher_replacement_db существует.');
            } else if (/relation "teachers" does not exist/i.test(error.message)) {
                console.error('');
                console.error('💡 База не инициализирована. Сначала выполните: npm run init-db:yes');
            } else if (/column "audiense" does not exist|column "type" does not exist/i.test(error.message)) {
                console.error('');
                console.error('💡 Не хватает колонок в timetable. Перезапустите импорт — миграция выполнится автоматически.');
            } else if (/ECONNREFUSED/i.test(error.message)) {
                console.error('');
                console.error('💡 PostgreSQL не запущен. Запустите сервер БД и повторите импорт.');
            }
            process.exit(1);
        }
    })();
}
