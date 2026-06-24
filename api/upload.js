export default async function handler(req, res) {
    // Разрешаем только POST-запросы
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Метод не разрешен' });
    }

    try {
        const { fileData, fileName, mimeType } = req.body; 

        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

        if (!supabaseUrl || !supabaseKey) {
            return res.status(500).json({ error: 'Нет ключей базы данных' });
        }

        // Очищаем формат Base64
        const base64Cleaned = fileData.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Cleaned, 'base64');

        // РЕШЕНИЕ ПРОБЛЕМЫ: Кодируем пробелы и кириллицу в безопасный URL-формат
        const safeName = encodeURIComponent(fileName);
        const uniqueName = `${Date.now()}-${safeName}`;

        // Теперь ссылка 100% безопасна
        const uploadUrl = `${supabaseUrl}/storage/v1/object/covers/${uniqueName}`;
        
        const uploadRes = await fetch(uploadUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${supabaseKey}`,
                'Content-Type': mimeType || 'image/jpeg',
                'apikey': supabaseKey
            },
            body: buffer
        });

        if (!uploadRes.ok) {
            // Если Supabase отклонил файл, читаем его реальную причину и отдаем на экран
            const errText = await uploadRes.text();
            return res.status(uploadRes.status).json({ error: `Отказ базы: ${errText}` });
        }

        // Формируем вечную ссылку
        const publicUrl = `${supabaseUrl}/storage/v1/object/public/covers/${uniqueName}`;
        return res.status(200).json({ url: publicUrl });

    } catch (error) {
        // Если сломался сам код, выводим техническую деталь на экран
        console.error('Сбой сервера:', error);
        return res.status(500).json({ error: `Технический сбой: ${error.message}` });
    }
}
