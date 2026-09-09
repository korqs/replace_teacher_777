#!/usr/bin/env node
/**
 * Проверка SMTP: задайте SMTP_* и EMAIL_ENABLED=true в .env
 * node test-email.js [email@example.com]
 */
require('dotenv').config();
const { sendMail, isEmailEnabled } = require('./mail');

const to = process.argv[2] || process.env.SMTP_USER;

(async () => {
    if (!isEmailEnabled()) {
        console.error('❌ Email отключён. Установите EMAIL_ENABLED=true и SMTP_* в .env');
        process.exit(1);
    }

    if (!to) {
        console.error('❌ Укажите email получателя: node test-email.js user@example.com');
        process.exit(1);
    }

    console.log(`📧 Отправка тестового письма на ${to}...`);

    await sendMail({
        to,
        subject: 'Тест: система замены преподавателей',
        text: 'Если вы видите это письмо, SMTP настроен корректно.',
        html: '<p>Если вы видите это письмо, <strong>SMTP настроен корректно</strong>.</p>'
    });

    console.log('✅ Готово (проверьте лог выше на ошибки отправки)');
})();
