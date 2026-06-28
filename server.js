const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto'); // Добавили модуль для криптографии
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3000;

// Лимит 10mb для загрузки тяжелых картинок
app.use(express.json({ limit: '10mb' }));
app.use(cors());

// Отдаем твой интерфейс (index.html)
app.use(express.static(path.join(__dirname, '/')));

// Подключаем базу данных
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// 1. Загрузка настроек формы
app.get('/api/load', async (req, res) => {
    const gid = req.query.gid;
    if (!gid) return res.status(400).json({ error: 'No vk_group_id' });

    try {
        const { data, error } = await supabase
            .from('forms')
            .select('*')
            .eq('vk_group_id', gid)
            .single();

        if (error && error.code !== 'PGRST116') throw error; 
        return res.status(200).json(data || { fields: [] });
    } catch (err) {
        console.error('Ошибка загрузки:', err);
        res.status(500).json({ error: 'DB Error' });
    }
});

// 2. Сохранение настроек формы (С ПОЛНОЙ ЗАЩИТОЙ ИЗ VERCEL)
app.post('/api/save', async (req, res) => {
    const { vk_group_id, fields, launch_params } = req.body;
    if (!vk_group_id || !launch_params) return res.status(400).json({ error: 'No data' });

    try {
        // --- БЛОК БЕЗОПАСНОСТИ НАЧАЛО ---
        const secret = process.env.VK_APP_SECRET; 
        const urlParams = new URLSearchParams(launch_params);
        const sign = urlParams.get('sign');
        
        // 1. ПРОВЕРКА ЦИФРОВОЙ ПОДПИСИ ВК
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

        // 2. АНТИ-IDOR: ЖЕСТКАЯ ПРОВЕРКА ID ГРУППЫ
        const signedGroupId = urlParams.get('vk_group_id');
        if (String(vk_group_id) !== String(signedGroupId)) {
            return res.status(403).json({ error: 'IDOR Атака! Попытка подмены ID группы.' });
        }

        // 3. ПРОВЕРКА ПРАВ
        const role = urlParams.get('vk_viewer_group_role');
        const isOwner = urlParams.get('vk_viewer_id') === '52069477';
        if (role !== 'admin' && role !== 'editor' && !isOwner) {
            return res.status(403).json({ error: 'Нет прав администратора сообщества' });
        }

        // 4. ВАЛИДАЦИЯ ДАННЫХ
        if (fields && Array.isArray(fields)) {
            for (const form of fields) {
                const name = form.internal_name ? String(form.internal_name).trim() : '';
                if (!name) return res.status(400).json({ error: 'Bad Request: Название формы не может быть пустым' });
                if (name.length > 200) return res.status(400).json({ error: 'Bad Request: Название превышает лимит' });
            }
        }
        // --- БЛОК БЕЗОПАСНОСТИ КОНЕЦ ---

        // 5. ОТПРАВКА В БАЗУ ДАННЫХ
        const { error } = await supabase
            .from('forms')
            .upsert(
                { vk_group_id: signedGroupId, fields, launch_params },
                { onConflict: 'vk_group_id' }
            );

        if (error) throw error;
        return res.status(200).json({ success: true });
    } catch (err) {
        console.error('Ошибка сохранения:', err);
        res.status(500).json({ error: 'DB Error' });
    }
});

// 3. Загрузка обложки в хранилище Supabase (С БЕЗОПАСНЫМИ ИМЕНАМИ)
app.post('/api/upload', async (req, res) => {
    const { fileData, mimeType } = req.body;
    if (!fileData) return res.status(400).json({ error: 'No file' });

    try {
        const base64Data = fileData.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');
        
        // ЖЕЛЕЗОБЕТОННОЕ РЕШЕНИЕ ИЗ VERCEL (Системное имя файла)
        const uniqueName = `cover-${Date.now()}-${Math.floor(Math.random() * 1000)}.jpg`;

        const { error } = await supabase.storage
            .from('covers')
            .upload(uniqueName, buffer, { contentType: mimeType || 'image/jpeg' });

        if (error) throw error;

        const { data: publicData } = supabase.storage.from('covers').getPublicUrl(uniqueName);
        return res.status(200).json({ url: publicData.publicUrl });
    } catch (err) {
        console.error('Ошибка загрузки картинки:', err);
        res.status(500).json({ error: 'Upload Error' });
    }
});

// 4. Отправка сообщений в личку ВК
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

// Если запрашивают что-то другое - отдаем интерфейс приложения
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Запуск
app.listen(port, '0.0.0.0', () => {
    console.log(`Сервер запущен на порту ${port}`);
});
