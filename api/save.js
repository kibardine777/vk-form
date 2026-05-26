import crypto from 'crypto';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Метод не разрешен');

    const { vk_group_id, fields, launch_params } = req.body;

    // 1. ПРОВЕРКА ЦИФРОВОЙ ПОДПИСИ ВК
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

    // 4. ВАЛИДАЦИЯ ДАННЫХ (Бэкенд-защита от прямых API-запросов)
    if (fields && Array.isArray(fields)) {
        for (const form of fields) {
            const name = form.internal_name ? String(form.internal_name).trim() : '';
            if (!name) {
                return res.status(400).json({ error: 'Bad Request: Название формы не может быть пустым' });
            }
            if (name.length > 200) {
                return res.status(400).json({ error: 'Bad Request: Название формы превышает лимит в 200 символов' });
            }
        }
    }

    // 5. ОТПРАВКА В БАЗУ ДАННЫХ
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    const response = await fetch(`${supabaseUrl}/rest/v1/forms?on_conflict=vk_group_id`, {
        method: 'POST',
        headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({ vk_group_id: signedGroupId, fields })
    });

    if (!response.ok) return res.status(500).json({ error: 'Ошибка сохранения БД' });

    res.status(200).json({ success: true });
}
