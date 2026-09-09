const MIN_COEFFICIENT = 0.1;

function mapLessonTypeToCompetency(type) {
    const key = String(type ?? '').trim().toLowerCase();
    if (key === 'лекция') return 'lecture';
    if (key === 'семинар') return 'seminar';
    if (key === 'лабораторная работа') return 'seminar';
    return 'seminar';
}

function competencyTypeToRussian(lessonType) {
    if (lessonType === 'lecture') return 'лекция';
    if (lessonType === 'seminar') return 'семинар';
    return null;
}

function clampCoefficient(value) {
    return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}

/**
 * Коэффициент компетенции по доле занятий преподавателя среди всех по предмету и типу.
 * Чем чаще ведёт — тем выше коэффициент (от MIN_COEFFICIENT до 1).
 */
function calculateCompetencyCoefficient(lessonCount, maxLessonCount) {
    const count = Number(lessonCount) || 0;
    const maxCount = Number(maxLessonCount) || 0;

    if (count <= 0 || maxCount <= 0) {
        return MIN_COEFFICIENT;
    }

    return clampCoefficient(MIN_COEFFICIENT + (count / maxCount) * (1 - MIN_COEFFICIENT));
}

async function fetchLessonCountsByTeacher(pool, subject, lessonType) {
    const typeRu = competencyTypeToRussian(lessonType);
    let result;

    if (typeRu) {
        result = await pool.query(
            `SELECT teacher, COUNT(*)::int AS count
             FROM timetable
             WHERE subject = $1 AND LOWER(TRIM(type)) = $2
             GROUP BY teacher`,
            [subject, typeRu]
        );
    } else {
        result = await pool.query(
            `SELECT teacher, COUNT(*)::int AS count
             FROM timetable
             WHERE subject = $1
             GROUP BY teacher`,
            [subject]
        );
    }

    const countsByTeacher = new Map();
    let maxCount = 0;

    for (const row of result.rows) {
        countsByTeacher.set(row.teacher, row.count);
        if (row.count > maxCount) {
            maxCount = row.count;
        }
    }

    return { countsByTeacher, maxCount };
}

function buildTeacherCompetency(teacherName, countsByTeacher, maxCount) {
    const lessonCount = countsByTeacher.get(teacherName) || 0;
    const coefficient = calculateCompetencyCoefficient(lessonCount, maxCount);

    return {
        coefficient,
        lesson_count: lessonCount,
        max_lesson_count: maxCount
    };
}

module.exports = {
    MIN_COEFFICIENT,
    mapLessonTypeToCompetency,
    calculateCompetencyCoefficient,
    fetchLessonCountsByTeacher,
    buildTeacherCompetency
};
