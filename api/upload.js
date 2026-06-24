export default async function handler(req, res) {
    // Разрешаем только POST-запросы
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Метод не разрешен' });
    }

    try {
        // Получаем картинку и её название от нашего фронтенда
        const { fileData, fileName, mimeType } = req.body; 

        // Берем ключи от базы из скрытых настроек Vercel
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

        if (!supabaseUrl || !supabaseKey) {
            return res.status(500).json({ error: 'Не найдены ключи Supabase' });
        }

        // Очищаем формат Base64 и превращаем в настоящий файл (буфер)
        const base64Cleaned = fileData.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Cleaned, 'base64');

        // Генерируем уникальное имя, чтобы картинки не перезаписывали друг друга
        const uniqueName = `${Date.now()}-${fileName}`;

        // Отправляем файл напрямую в корзину covers в Supabase
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
            const err = await uploadRes.text();
            throw new Error(err);
        }

        // Формируем вечную публичную ссылку на загруженную картинку
        const publicUrl = `${supabaseUrl}/storage/v1/object/public/covers/${uniqueName}`;

        // Возвращаем ссылку нашему приложению
        return res.status(200).json({ url: publicUrl });

    } catch (error) {
        console.error('Ошибка загрузки файла:', error);
        return res.status(500).json({ error: 'Не удалось загрузить файл' });
    }
}
