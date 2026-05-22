export default async function handler(req, res) {
    // Разрешаем только GET-запросы
    if (req.method !== 'GET') return res.status(405).send('Метод не разрешен');

    const { gid } = req.query;
    if (!gid) return res.status(400).json({ error: 'Не указан ID группы' });

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    try {
        // Vercel запрашивает данные у Supabase (это происходит мгновенно)
        const response = await fetch(`${supabaseUrl}/rest/v1/forms?vk_group_id=eq.${gid}&select=*`, {
            headers: {
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            return res.status(500).json({ error: 'Ошибка БД' });
        }

        const data = await response.json();
        
        // Отдаем форму в ВК (первую найденную или ничего, если группа новая)
        res.status(200).json(data.length > 0 ? data[0] : null);

    } catch (error) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
}
