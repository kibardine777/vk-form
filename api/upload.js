export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Метод не разрешен' });
    }

    try {
        const { fileData, mimeType } = req.body; 

        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

        if (!supabaseUrl || !supabaseKey) {
            return res.status(500).json({ error: 'Нет ключей базы данных' });
        }

        const base64Cleaned = fileData.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Cleaned, 'base64');

        // ЖЕЛЕЗОБЕТОННОЕ РЕШЕНИЕ: 
        // Игнорируем старое название и создаем чистое системное имя
        const uniqueName = `cover-${Date.now()}-${Math.floor(Math.random() * 1000)}.jpg`;

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
            const errText = await uploadRes.text();
            return res.status(uploadRes.status).json({ error: `Отказ базы: ${errText}` });
        }

        const publicUrl = `${supabaseUrl}/storage/v1/object/public/covers/${uniqueName}`;
        return res.status(200).json({ url: publicUrl });

    } catch (error) {
        console.error('Сбой сервера:', error);
        return res.status(500).json({ error: `Технический сбой: ${error.message}` });
    }
}
