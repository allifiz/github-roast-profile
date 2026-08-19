export default async function handler(request, response) {
  if (request.method !== "POST") {
    return response.status(405).json({ message: "Method tidak diizinkan." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return response.status(503).json({
      message: "Gemini belum dikonfigurasi. Tambahkan GEMINI_API_KEY di Environment Variables Vercel.",
    });
  }

  const prompt = `Kamu adalah komedian developer Indonesia yang nyinyir, tajam, dan lucu.
Buat roast GitHub BERBAHASA INDONESIA dari data profil publik di bawah.

Aturan:
- Serang hanya kualitas profil, repo, dokumentasi, fokus teknologi, dan kebiasaan coding.
- Jangan menghina identitas, fisik, keluarga, agama, kondisi kesehatan, atau membuat klaim di luar data.
- Sarkas boleh panas, tetapi harus terasa cerdas dan aman untuk dibagikan.
- Balas HANYA JSON valid, tanpa markdown.

Data:
${JSON.stringify(request.body)}

Format:
{"title":"judul pendek maksimal 7 kata","line":"1 roast tajam maksimal 45 kata","nudge":"1 saran konkret maksimal 35 kata"}`;

  try {
    const geminiResponse = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 1.05,
            responseMimeType: "application/json",
          },
        }),
      },
    );

    if (!geminiResponse.ok) {
      return response.status(502).json({ message: "Gemini lagi ngambek. Coba lagi sebentar." });
    }

    const result = await geminiResponse.json();
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
    const json = text?.match(/\{[\s\S]*\}/)?.[0];

    if (!json) {
      return response.status(502).json({ message: "Gemini ngasih jawaban nggak kebaca. Hajar ulang." });
    }

    return response.status(200).json(JSON.parse(json));
  } catch {
    return response.status(502).json({ message: "Mesin roasting lagi kepanasan. Coba lagi." });
  }
}