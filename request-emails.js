const { sendMail } = require('./mail');

const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');

function formatRequestDate(value) {
    if (!value) return '';
    const str = typeof value === 'string'
        ? value.slice(0, 10)
        : value instanceof Date
            ? [
                value.getFullYear(),
                String(value.getMonth() + 1).padStart(2, '0'),
                String(value.getDate()).padStart(2, '0')
            ].join('-')
            : String(value).slice(0, 10);
    const d = new Date(`${str}T12:00:00`);
    if (Number.isNaN(d.getTime())) return str;
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function escapeHtml(str) {
    return String(str ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

function buildRequestSummary(request) {
    const date = formatRequestDate(request.request_date);
    const pair = request.classes;
    return {
        date,
        subjectLine: `Заявка на замену: ${request.subject}, ${date}, ${pair} пара`,
        fields: [
            ['Предмет', request.subject],
            ['Группа', request.team],
            ['Дата', date],
            ['Пара', `${pair}`],
            ['Инициатор', request.teacher_name],
            ['Замещающий', request.replacing_teacher || '—']
        ]
    };
}

function renderEmailHtml(title, intro, fields, ctaLabel = 'Открыть систему') {
    const rows = fields
        .map(([label, value]) => `
            <tr>
                <td style="padding:8px 12px;color:#64748b;width:140px;vertical-align:top;">${escapeHtml(label)}</td>
                <td style="padding:8px 12px;color:#1e293b;font-weight:500;">${escapeHtml(value)}</td>
            </tr>`)
        .join('');

    return `
<!DOCTYPE html>
<html lang="ru">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
        <tr>
          <td style="background:#2563eb;color:#fff;padding:20px 24px;font-size:18px;font-weight:bold;">
            ${escapeHtml(title)}
          </td>
        </tr>
        <tr>
          <td style="padding:24px;color:#334155;font-size:15px;line-height:1.5;">
            <p style="margin:0 0 16px;">${intro}</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:8px;margin-bottom:20px;">
              ${rows}
            </table>
            <a href="${APP_URL}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold;">
              ${escapeHtml(ctaLabel)}
            </a>
            <p style="margin:20px 0 0;font-size:12px;color:#94a3b8;">
              Система замены преподавателей · <a href="${APP_URL}" style="color:#64748b;">${escapeHtml(APP_URL)}</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function getTeacherEmail(pool, teacherName) {
    if (!teacherName) return null;
    const result = await pool.query(
        'SELECT email FROM teachers WHERE name = $1',
        [teacherName]
    );
    return result.rows[0]?.email || null;
}

function notifyInBackground(fn) {
    Promise.resolve()
        .then(fn)
        .catch((err) => {
            console.error('📧 Ошибка отправки уведомления:', err.message);
        });
}

async function notifyNewReplacementRequest(pool, request) {
    if (!request.replacing_teacher) return;

    const to = await getTeacherEmail(pool, request.replacing_teacher);
    if (!to) {
        console.warn(`📧 Нет email для преподавателя: ${request.replacing_teacher}`);
        return;
    }

    const summary = buildRequestSummary(request);
    const html = renderEmailHtml(
        'Новая заявка на замену',
        `${escapeHtml(request.teacher_name)} просит вас заменить на занятии. Откройте раздел «Мои заявки», чтобы принять или отклонить заявку.`,
        summary.fields
    );

    await sendMail({
        to,
        subject: summary.subjectLine,
        html
    });
}

async function notifyRequestResponded(pool, request, action) {
    const to = await getTeacherEmail(pool, request.teacher_name);
    if (!to) {
        console.warn(`📧 Нет email для инициатора: ${request.teacher_name}`);
        return;
    }

    const summary = buildRequestSummary(request);
    const accepted = action === 'accept';
    const title = accepted ? 'Замена подтверждена' : 'Замена отклонена';
    const intro = accepted
        ? `${escapeHtml(request.replacing_teacher)} согласился(ась) провести замену.`
        : `${escapeHtml(request.replacing_teacher)} отклонил(а) заявку на замену.`;

    const html = renderEmailHtml(title, intro, summary.fields);

    await sendMail({
        to,
        subject: `${title}: ${request.subject}, ${summary.date}`,
        html
    });
}

async function notifyRequestCancelled(pool, request) {
    if (!request.replacing_teacher) return;

    const to = await getTeacherEmail(pool, request.replacing_teacher);
    if (!to) return;

    const summary = buildRequestSummary(request);
    const html = renderEmailHtml(
        'Заявка на замену отменена',
        `${escapeHtml(request.teacher_name)} отменил(а) заявку, в которой вы были указаны как замещающий преподаватель.`,
        summary.fields
    );

    await sendMail({
        to,
        subject: `Отмена заявки: ${request.subject}, ${summary.date}`,
        html
    });
}

module.exports = {
    notifyInBackground,
    notifyNewReplacementRequest,
    notifyRequestResponded,
    notifyRequestCancelled,
    formatRequestDate,
    buildRequestSummary
};
