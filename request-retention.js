/**
 * Хранение заявок: архив подтверждённых и удаление отменённых старше N месяцев.
 * Возраст считается по дате занятия (request_date), не по дате создания записи.
 */
const REQUEST_RETENTION_MONTHS = Math.max(
    1,
    parseInt(process.env.REQUEST_RETENTION_MONTHS || '6', 10) || 6
);

/** SQL-выражение пороговой даты (DATE) */
function getRetentionCutoffSql() {
    return `CURRENT_DATE - INTERVAL '${REQUEST_RETENTION_MONTHS} months'`;
}

async function ensureArchiveSchema(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS replacement_requests_archive (
            id INTEGER PRIMARY KEY,
            teacher_name TEXT NOT NULL,
            request_date DATE NOT NULL,
            week_num INTEGER NOT NULL,
            num_den TEXT,
            classes INTEGER NOT NULL,
            subject TEXT NOT NULL,
            team TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'confirmed',
            replacing_teacher TEXT,
            admin_comment TEXT,
            created_at TIMESTAMP NOT NULL,
            updated_at TIMESTAMP NOT NULL,
            archived_at TIMESTAMP DEFAULT NOW()
        )
    `);
    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_replacement_requests_archive_created
        ON replacement_requests_archive (created_at DESC)
    `);
}

/**
 * Подтверждённые старше порога → архив; отменённые старше порога → удаление.
 * @returns {{ archived: number, deletedCancelled: number }}
 */
async function runRequestRetention(pool) {
    const client = await pool.connect();
    const cutoff = getRetentionCutoffSql();

    try {
        await client.query('BEGIN');

        const archiveResult = await client.query(`
            WITH moved AS (
                DELETE FROM replacement_requests
                WHERE status = 'confirmed'
                  AND request_date < ${cutoff}
                RETURNING
                    id, teacher_name, request_date, week_num, num_den,
                    classes, subject, team, status, replacing_teacher,
                    admin_comment, created_at, updated_at
            )
            INSERT INTO replacement_requests_archive (
                id, teacher_name, request_date, week_num, num_den,
                classes, subject, team, status, replacing_teacher,
                admin_comment, created_at, updated_at, archived_at
            )
            SELECT
                id, teacher_name, request_date, week_num, num_den,
                classes, subject, team, status, replacing_teacher,
                admin_comment, created_at, updated_at, NOW()
            FROM moved
        `);

        const deleteResult = await client.query(`
            DELETE FROM replacement_requests
            WHERE status = 'cancelled'
              AND request_date < ${cutoff}
        `);

        await client.query('COMMIT');

        const archived = archiveResult.rowCount || 0;
        const deletedCancelled = deleteResult.rowCount || 0;

        if (archived > 0 || deletedCancelled > 0) {
            console.log(
                `📦 Хранение заявок: в архив — ${archived}, удалено отменённых — ${deletedCancelled}`
            );
        }

        return { archived, deletedCancelled };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

function scheduleRequestRetention(pool, intervalMs = 24 * 60 * 60 * 1000) {
    const tick = () => {
        runRequestRetention(pool).catch((err) => {
            console.warn('⚠️ Ошибка фоновой очистки заявок:', err.message);
        });
    };

    const timer = setInterval(tick, intervalMs);
    if (typeof timer.unref === 'function') {
        timer.unref();
    }
    return timer;
}

module.exports = {
    REQUEST_RETENTION_MONTHS,
    getRetentionCutoffSql,
    ensureArchiveSchema,
    runRequestRetention,
    scheduleRequestRetention
};
