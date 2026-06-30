const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, '/')));

// ==========================================
// 1. Подключение к базе данных PostgreSQL
// ==========================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL
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
    const gid = req.query.gid;
    if (!gid) return res.status(400).json({ error: 'No vk_group_id' });

    try {
        const result = await pool.query('SELECT * FROM forms WHERE vk_group_id = $1', [gid]);
        if (result.rows.length === 0) {
            return res.status(200).json({ fields: [] });
        }
        return res.status(200).json(result.rows[0]);
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

// Отправка сообщений в личку ВК
app.post('/api/vk-message', async (req, res) => {
    const { token, admin_id, text } = req.body;
    try {
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

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, '0.0.0.0', () => {
    console.log('==============================');
    console.log(`Сервер запущен на порту ${port}`);
    console.log('==============================');
});
