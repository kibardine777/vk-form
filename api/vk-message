export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const { token, admin_id, text } = req.body;

    if (!token || !admin_id || !text) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // Собираем запрос к API ВКонтакте
    const url = `https://api.vk.com/method/messages.send`;
    const params = new URLSearchParams({
        access_token: token,
        peer_id: admin_id,
        message: text,
        v: '5.131',
        random_id: Math.floor(Math.random() * 1000000000)
    });

    try {
        const vkRes = await fetch(url, { method: 'POST', body: params });
        const vkData = await vkRes.json();
        return res.status(200).json(vkData);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
}
