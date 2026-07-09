const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
// Хранилище таймеров для "Ловца лидов"
const abandonedTimers = new Map();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, '/')));

// ==========================================
// 1. Подключение к базе данных PostgreSQL
// ==========================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Включаем обязательное шифрование для публичного IP
    }
});

// Защита от падения сервера при кратковременных обрывах связи
pool.on('error', (err) => {
    console.error('Ошибка фонового соединения с БД:', err);
});

pool.query(`
    CREATE TABLE IF NOT EXISTS forms (
        vk_group_id VARCHAR(255) PRIMARY KEY,
        fields JSONB,
        launch_params TEXT
    )
`).then(() => console.log('Таблица forms готова к работе'))
  .catch(err => console.error('Ошибка создания таблицы:', err));

// ==========================================
// 2. Подключение к S3 Хранилищу (Timeweb)
// ==========================================
const s3 = new S3Client({
    region: 'ru-1', 
    endpoint: 'https://s3.twcstorage.ru',
    credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY,
        secretAccessKey: process.env.S3_SECRET_KEY
    },
    forcePathStyle: true
});
const BUCKET_NAME = 'vk-forms-images';

// ==========================================
// РОУТЫ ПРИЛОЖЕНИЯ
// ==========================================

// Загрузка настроек формы
app.get('/api/load', async (req, res) => {
    const { gid, launch_params } = req.query; // Добавили launch_params
    if (!gid) return res.status(400).json({ error: 'No vk_group_id' });

    try {
        const result = await pool.query('SELECT * FROM forms WHERE vk_group_id = $1', [gid]);
        if (result.rows.length === 0) {
            return res.status(200).json({ fields: [] });
        }
        const row = result.rows[0];

        if (row.is_pro && row.pro_expires_at && new Date(row.pro_expires_at) < new Date()) {
            row.is_pro = false;
        }

        // === БЛОКИРОВКА УТЕЧКИ ТОКЕНА ===
        let isAdmin = false;
        if (launch_params) {
            const urlParams = new URLSearchParams(launch_params);
            const role = urlParams.get('vk_viewer_group_role');
            const isOwner = urlParams.get('vk_viewer_id') === '52069477';
            if (role === 'admin' || role === 'editor' || isOwner) isAdmin = true;
        }

        // Если зашел обычный клиент — вырезаем токен группы из ответа!
        if (!isAdmin && row.fields) {
            row.fields = row.fields.map(f => {
                const safeForm = { ...f };
                delete safeForm.group_token;
                return safeForm;
            });
        }

        return res.status(200).json(row);
    } catch (err) {
        console.error('Ошибка загрузки:', err);
        res.status(500).json({ error: 'DB Error' });
    }
});

// Сохранение настроек формы
app.post('/api/save', async (req, res) => {
    const { vk_group_id, fields, launch_params } = req.body;
    if (!vk_group_id || !launch_params) return res.status(400).json({ error: 'No data' });

    try {
        const secret = process.env.VK_APP_SECRET; 
        const urlParams = new URLSearchParams(launch_params);
        const sign = urlParams.get('sign');
        
        const queryParams = [];
        for (const [key, value] of urlParams.entries()) {
            if (key.startsWith('vk_')) queryParams.push({ key, value });
        }
        
        const queryString = queryParams
            .sort((a, b) => a.key.localeCompare(b.key))
            .map(({ key, value }) => `${key}=${encodeURIComponent(value)}`)
            .join('&');
            
        const paramsHash = crypto
            .createHmac('sha256', secret)
            .update(queryString)
            .digest('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=$/, '');
            
        if (paramsHash !== sign) {
            return res.status(403).json({ error: 'Взлом! Неверная подпись ВК.' });
        }

        const signedGroupId = urlParams.get('vk_group_id');
        if (String(vk_group_id) !== String(signedGroupId)) {
            return res.status(403).json({ error: 'IDOR Атака! Попытка подмены ID группы.' });
        }

        const role = urlParams.get('vk_viewer_group_role');
        const isOwner = urlParams.get('vk_viewer_id') === '52069477';
        if (role !== 'admin' && role !== 'editor' && !isOwner) {
            return res.status(403).json({ error: 'Нет прав администратора сообщества' });
        }

        // === НОВЫЙ БЛОК: ПРОВЕРКА ЛИМИТОВ И ВРЕМЕНИ PRO ===
        const checkPro = await pool.query('SELECT is_pro, pro_expires_at FROM forms WHERE vk_group_id = $1', [signedGroupId]);
        let isPro = false;
        
        if (checkPro.rows.length > 0) {
            const row = checkPro.rows[0];
            // PRO активен, если стоит галочка И (время не указано ИЛИ оно еще не вышло)
            if (row.is_pro && (!row.pro_expires_at || new Date(row.pro_expires_at) > new Date())) {
                isPro = true;
            }
        }

        if (!isPro && fields.length > 2) {
            return res.status(403).json({ error: 'На бесплатном тарифе можно создать только 2 формы. Выберите тариф PRO.' });
        }
        // === КОНЕЦ НОВОГО БЛОКА ===

        const query = `
            INSERT INTO forms (vk_group_id, fields, launch_params)
            VALUES ($1, $2, $3)
            ON CONFLICT (vk_group_id)
            DO UPDATE SET fields = EXCLUDED.fields, launch_params = EXCLUDED.launch_params
        `;
        await pool.query(query, [signedGroupId, JSON.stringify(fields), launch_params]);

        return res.status(200).json({ success: true });
    } catch (err) {
        console.error('Ошибка сохранения:', err);
        res.status(500).json({ error: 'DB Error' });
    }
});

// Загрузка картинок через кнопку
app.post('/api/upload', async (req, res) => {
    const { fileData } = req.body;
    if (!fileData) return res.status(400).json({ error: 'No file' });

    try {
        const base64Data = fileData.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');
        
        const uniqueName = `cover-${Date.now()}-${Math.floor(Math.random() * 1000)}.jpg`;

        const command = new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: uniqueName,
            Body: buffer,
            ContentType: 'image/jpeg'
        });

        await s3.send(command);

        // Формируем публичную ссылку для сохранения
        const publicUrl = `https://s3.twcstorage.ru/${BUCKET_NAME}/${uniqueName}`;
        return res.status(200).json({ url: publicUrl });
    } catch (err) {
        console.error('Ошибка загрузки в S3:', err);
        res.status(500).json({ error: 'Upload Error' });
    }
});

// ==========================================
// ВЫГРУЗКА И СОХРАНЕНИЕ ЗАЯВОК (CRM)
// ==========================================

// 1. Тихое сохранение новой заявки в базу (и отмена таймера упущенного лида)
app.post('/api/submit-lead', async (req, res) => {
    const { vk_group_id, form_id, client_id, data, launch_params } = req.body;
    if (!vk_group_id || !form_id || !data || !launch_params) return res.status(400).json({ error: 'Bad data' });
    
    try {
        // Защита от спам-ботов: проверяем, что запрос пришел реально из окна ВК
        const urlParams = new URLSearchParams(launch_params);
        const secret = process.env.VK_APP_SECRET;
        const sign = urlParams.get('sign');
        const queryParams = [];
        for (const [key, value] of urlParams.entries()) {
            if (key.startsWith('vk_')) queryParams.push({ key, value });
        }
        const queryString = queryParams.sort((a, b) => a.key.localeCompare(b.key)).map(({ key, value }) => `${key}=${encodeURIComponent(value)}`).join('&');
        const paramsHash = crypto.createHmac('sha256', secret).update(queryString).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=$/, '');

        if (paramsHash !== sign) {
            return res.status(403).json({ error: 'Неверная подпись ВК' });
        }

        // Отменяем таймер Ловца лидов, так как человек всё-таки отправил заявку!
        if (client_id) {
            const timerKey = `${vk_group_id}_${form_id}_${client_id}`;
            if (abandonedTimers.has(timerKey)) {
                clearTimeout(abandonedTimers.get(timerKey));
                abandonedTimers.delete(timerKey);
            }
        }

        await pool.query(
            'INSERT INTO leads (vk_group_id, form_id, data) VALUES ($1, $2, $3)',
            [vk_group_id, form_id, JSON.stringify(data)]
        );
        res.status(200).json({ success: true });
    } catch (err) {
        console.error('Ошибка сохранения лида:', err);
        res.status(500).json({ error: 'DB Error' });
    }
});

// === НОВЫЙ РОУТ: Запуск таймера при открытии формы ===
app.post('/api/track-open', (req, res) => { 
    const { vk_group_id, form_id, form_name, client_id, admin_ids, launch_params } = req.body;
    if (!admin_ids || !client_id || !launch_params) return res.status(200).json({ status: 'skip' });

    // Проверка подписи от спамеров
    const urlParams = new URLSearchParams(launch_params);
    const secret = process.env.VK_APP_SECRET;
    const sign = urlParams.get('sign');
    const queryParams = [];
    for (const [key, value] of urlParams.entries()) {
        if (key.startsWith('vk_')) queryParams.push({ key, value });
    }
    const queryString = queryParams.sort((a, b) => a.key.localeCompare(b.key)).map(({ key, value }) => `${key}=${encodeURIComponent(value)}`).join('&');
    const paramsHash = crypto.createHmac('sha256', secret).update(queryString).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=$/, '');
    if (paramsHash !== sign) return res.status(200).json({ status: 'skip' });

    const timerKey = `${vk_group_id}_${form_id}_${client_id}`;

    if (!abandonedTimers.has(timerKey)) {
        const timer = setTimeout(async () => {
            try {
                // ДОСТАЕМ ТОКЕН НАПРЯМУЮ ИЗ БД
                const dbRes = await pool.query('SELECT fields FROM forms WHERE vk_group_id = $1', [vk_group_id]);
                if (dbRes.rows.length === 0) return;
                let token = null;
                for (let f of dbRes.rows[0].fields) {
                    if (f.group_token) { token = f.group_token; break; }
                }
                if (!token) return; 

                const message = `🧲 Ловец упущенных лидов!\n\nПользователь @id${client_id} открыл вашу форму «${form_name}» более 10 минут назад, но так и не отправил заявку.\n\nВозможно, у него остались вопросы. Вы можете написать ему первыми и помочь с выбором!`;

                const idsArray = admin_ids.split(',').map(id => id.trim()).filter(id => id);
                for (const adminId of idsArray) {
                    const url = `https://api.vk.com/method/messages.send?user_id=${adminId}&message=${encodeURIComponent(message)}&random_id=${Math.floor(Math.random() * 1000000)}&v=5.131&access_token=${token}`;
                    await fetch(url);
                }
            } catch (e) { console.error('Ошибка отправки ловца:', e); }

            abandonedTimers.delete(timerKey);
        }, 10 * 60 * 1000);

        abandonedTimers.set(timerKey, timer);
    }
    res.status(200).json({ success: true });
});

// 2. Скачивание заявок в CSV (Только для PRO + Защита)
app.get('/api/export-leads', async (req, res) => {
    const { gid, form_id, launch_params } = req.query;

    try {
        // Проверка подписи: скачивать может только администратор группы
        if (!launch_params) return res.status(403).json({ error: 'Нет подписи' });
        const urlParams = new URLSearchParams(launch_params);
        const secret = process.env.VK_APP_SECRET;
        const sign = urlParams.get('sign');
        const queryParams = [];
        for (const [key, value] of urlParams.entries()) {
            if (key.startsWith('vk_')) queryParams.push({ key, value });
        }
        const queryString = queryParams.sort((a, b) => a.key.localeCompare(b.key)).map(({ key, value }) => `${key}=${encodeURIComponent(value)}`).join('&');
        const paramsHash = crypto.createHmac('sha256', secret).update(queryString).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=$/, '');

        if (paramsHash !== sign) return res.status(403).json({ error: 'Неверная подпись' });

        const role = urlParams.get('vk_viewer_group_role');
        const isOwner = urlParams.get('vk_viewer_id') === '52069477';
        if (role !== 'admin' && role !== 'editor' && !isOwner) {
            return res.status(403).json({ error: 'Нет прав' });
        }

        // Проверка тарифа PRO (серверная защита)
        const checkPro = await pool.query('SELECT is_pro, pro_expires_at FROM forms WHERE vk_group_id = $1', [gid]);
        let isPro = false;
        if (checkPro.rows.length > 0) {
            const row = checkPro.rows[0];
            if (row.is_pro && (!row.pro_expires_at || new Date(row.pro_expires_at) > new Date())) {
                isPro = true;
            }
        }

        if (!isPro) {
            return res.status(403).json({ error: 'Выгрузка доступна только на тарифе PRO.' });
        }

        // Достаем все заявки конкретной формы
        const leads = await pool.query('SELECT data, created_at FROM leads WHERE vk_group_id = $1 AND form_id = $2 ORDER BY created_at DESC', [gid, form_id]);

        if (leads.rows.length === 0) {
            return res.status(404).json({ error: 'В этой форме еще нет заявок.' });
        }

        let allKeys = new Set();
        leads.rows.forEach(row => {
            Object.keys(row.data).forEach(k => allKeys.add(k));
        });
        
        const headers = ['Дата', ...Array.from(allKeys)];
        
        let csvContent = '\uFEFF'; 
        csvContent += headers.map(h => `"${h}"`).join(';') + '\n';

        leads.rows.forEach(row => {
            const dateObj = new Date(row.created_at);
            const dateStr = dateObj.toLocaleString('ru-RU'); 
            
            const rowData = [dateStr];
            Array.from(allKeys).forEach(key => {
                let val = row.data[key] || '';
                val = String(val).replace(/"/g, '""'); 
                
                // ЗАЩИТА ОТ CSV-ИНЪЕКЦИЙ (Блокируем исполняемый код в Excel)
                if (/^[=+\-@\t\r]/.test(val)) {
                    val = "'" + val;
                }
                
                rowData.push(`"${val}"`);
            });
            csvContent += rowData.join(';') + '\n';
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="leads_${form_id}.csv"`);
        res.send(csvContent);

    } catch (err) {
        console.error('Ошибка выгрузки:', err);
        res.status(500).json({ error: 'Server Error' });
    }
});

// Отправка сообщений в личку ВК
app.post('/api/vk-message', async (req, res) => {
    const { vk_group_id, admin_id, text, launch_params } = req.body;
    
    try {
        // 1. Проверяем подпись (чтобы боты не отправляли спам от имени твоей группы)
        if (!launch_params) return res.status(403).json({ error: 'Нет подписи' });
        const urlParams = new URLSearchParams(launch_params);
        const secret = process.env.VK_APP_SECRET;
        const sign = urlParams.get('sign');
        const queryParams = [];
        for (const [key, value] of urlParams.entries()) {
            if (key.startsWith('vk_')) queryParams.push({ key, value });
        }
        const queryString = queryParams.sort((a, b) => a.key.localeCompare(b.key)).map(({ key, value }) => `${key}=${encodeURIComponent(value)}`).join('&');
        const paramsHash = crypto.createHmac('sha256', secret).update(queryString).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=$/, '');
        if (paramsHash !== sign) return res.status(403).json({ error: 'Неверная подпись' });

        // 2. Достаем токен безопасно из базы данных
        const dbRes = await pool.query('SELECT fields FROM forms WHERE vk_group_id = $1', [vk_group_id]);
        if (dbRes.rows.length === 0) return res.status(404).json({error: 'Form not found'});

        let token = null;
        for (let f of dbRes.rows[0].fields) {
            if (f.group_token) { token = f.group_token; break; }
        }
        if (!token) return res.status(400).json({error: 'No token in DB'});

        // 3. Отправляем сообщение
        const response = await fetch('https://api.vk.com/method/messages.send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                access_token: token,
                user_id: admin_id,
                message: text,
                random_id: Math.floor(Math.random() * 1000000),
                v: '5.131'
            })
        });
        const result = await response.json();
        return res.status(200).json(result);
    } catch (err) {
        console.error('Ошибка ВК:', err);
        res.status(500).json({ error: 'VK API Error' });
    }
});

// ==========================================
// ПЛАТЕЖНАЯ СИСТЕМА (ЮKassa)
// ==========================================
app.post('/api/pay', async (req, res) => {
    const { launch_params, plan } = req.body;
    const urlParams = new URLSearchParams(launch_params);
    const vk_group_id = urlParams.get('vk_group_id');
    const vk_app_id = urlParams.get('vk_app_id');

    let amount = '249.00';
    let description = 'PRO-тариф (1 месяц): до 10 форм';
    
    if (plan === '3months') {
        amount = '669.00';
        description = 'PRO-тариф (3 месяца): до 10 форм';
    } else if (plan === '1year') {
        amount = '2399.00';
        description = 'PRO-тариф (1 год): до 10 форм';
    }

    const auth = Buffer.from(`${process.env.YOOKASSA_SHOP_ID}:${process.env.YOOKASSA_SECRET_KEY}`).toString('base64');
    const idempotenceKey = crypto.randomUUID();

    try {
        const response = await fetch('https://api.yookassa.ru/v3/payments', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${auth}`,
                'Idempotence-Key': idempotenceKey
            },
            body: JSON.stringify({
                amount: { value: amount, currency: 'RUB' },
                capture: true,
                confirmation: { type: 'redirect', return_url: `https://vk.com/app${vk_app_id}_-${vk_group_id}` },
                description: description,
                metadata: { vk_group_id: vk_group_id, plan: plan }
            })
        });
        
        const data = await response.json();
        res.json({ url: data.confirmation.confirmation_url });
    } catch (err) {
        console.error('Ошибка платежа:', err);
        res.status(500).json({ error: 'Payment error' });
    }
});

app.post('/api/webhook', async (req, res) => {
    const event = req.body;
    if (event.event === 'payment.succeeded') {
        const vk_group_id = event.object.metadata.vk_group_id;
        const plan = event.object.metadata.plan; // Узнаем, какой тариф оплатили
        
        // Определяем, сколько времени добавлять
        let interval = '1 month';
        if (plan === '3months') interval = '3 months';
        if (plan === '1year') interval = '1 year';

        try {
            const query = `
                UPDATE forms 
                SET is_pro = true, 
                    pro_expires_at = CASE 
                        WHEN pro_expires_at > CURRENT_TIMESTAMP THEN pro_expires_at + INTERVAL '${interval}'
                        ELSE CURRENT_TIMESTAMP + INTERVAL '${interval}'
                    END
                WHERE vk_group_id = $1
            `;
            await pool.query(query, [vk_group_id]);
            console.log(`✅ Группа ${vk_group_id} купила PRO на ${interval}`);
        } catch (err) { 
            console.error('Ошибка БД при обновлении статуса:', err); 
        }
    }
    res.status(200).send('OK');
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, '0.0.0.0', () => {
    console.log('==============================');
    console.log(`Сервер запущен на порту ${port}`);
    console.log('==============================');
});
