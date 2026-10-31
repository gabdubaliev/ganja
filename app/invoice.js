'use strict';

// Распознавание накладной поставщика по фото через Claude API.
// Без npm-зависимостей (программа ставится одной командой на планшете и сервере), поэтому — прямой HTTPS-запрос.
// Ключ: переменная ANTHROPIC_API_KEY или настройка «anthropic_api_key», которую администратор вводит в программе.

const MODEL = 'claude-opus-5-5';

// Что вернуть: шапка накладной и строки. Пустые значения — '' и 0, без null.
const SCHEMA = {
  type: 'object',
  properties: {
    supplier: { type: 'string', description: 'Поставщик (продавец) из накладной' },
    number: { type: 'string', description: 'Номер накладной' },
    date: { type: 'string', description: 'Дата накладной в формате ГГГГ-ММ-ДД или пусто' },
    currency: { type: 'string', enum: ['USD', 'KGS', 'RUB', 'CNY', 'KZT', 'EUR', 'OTHER'], description: 'Валюта цен в накладной' },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Наименование товара как в накладной' },
          article: { type: 'string', description: 'Артикул или код поставщика, если есть' },
          barcode: { type: 'string', description: 'Штрихкод (EAN), если напечатан' },
          unit: { type: 'string', description: 'Единица: шт, кг, л, м, уп' },
          qty: { type: 'number', description: 'Количество' },
          price: { type: 'number', description: 'Цена за единицу в валюте накладной' },
          total: { type: 'number', description: 'Сумма строки в валюте накладной' },
        },
        required: ['name', 'article', 'barcode', 'unit', 'qty', 'price', 'total'],
        additionalProperties: false,
      },
    },
    total: { type: 'number', description: 'Итого по накладной' },
    notes: { type: 'string', description: 'Что не удалось прочитать или в чём сомнения — коротко по-русски' },
  },
  required: ['supplier', 'number', 'date', 'currency', 'lines', 'total', 'notes'],
  additionalProperties: false,
};

const PROMPT = `Это фото (или несколько фото страниц) накладной поставщика для магазина в Кыргызстане.
Перепиши все товарные строки по порядку, ничего не пропуская и не придумывая.
- Количество и цену за единицу бери из накладной. Если есть только сумма строки — посчитай цену как сумма / количество.
- Валюту определи по документу: $, USD, долл. — USD; сом, KGS — KGS; руб — RUB; юань, ¥ — CNY. Если не указана — USD для импортных оптовых накладных, иначе KGS.
- Наименование пиши как в накладной, исправляя только очевидные ошибки распознавания.
- Строки «Итого», «Скидка», «Доставка» — не товары, их в lines не включай.
- Если что-то не читается — заполни как можешь и коротко напиши об этом в notes.
Ответ — только JSON по заданной схеме.`;

function apiKey(store) {
  return process.env.ANTHROPIC_API_KEY || store.setting('anthropic_api_key', '');
}

async function recognize(store, images, UserError) {
  const key = apiKey(store);
  if (!key) throw new UserError('Распознавание не настроено: администратор вводит ключ Claude API на этой странице (блок «Распознавание фото»).');
  if (!Array.isArray(images) || !images.length) throw new UserError('Добавьте фото накладной');
  if (images.length > 10) throw new UserError('Не больше 10 фото за раз');
  const content = images.map((img) => {
    const mime = ['image/jpeg', 'image/png', 'image/webp'].includes(img.mime) ? img.mime : 'image/jpeg';
    if (typeof img.data !== 'string' || !img.data) throw new UserError('Фото не получилось прочитать');
    return { type: 'image', source: { type: 'base64', media_type: mime, data: img.data } };
  });
  content.push({ type: 'text', text: PROMPT });
  let res;
  try {
    res = await fetch(`${process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2026-10-21',
        // Если модель откажет по правилам безопасности, сервер сам повторит запрос на подходящей модели.
        'anthropic-beta': 'server-side-fallback-2026-07-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 16000,
        fallbacks: 'default',
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
        messages: [{ role: 'user', content }],
      }),
      signal: AbortSignal.timeout(240000),
    });
  } catch (err) {
    throw new UserError(err.name === 'TimeoutError' ? 'Распознавание заняло слишком долго. Попробуйте ещё раз или по одной странице.' : `Нет связи с Claude API: ${err.message}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || res.statusText;
    if (res.status === 401) throw new UserError('Ключ Claude API не подошёл — проверьте его в блоке «Распознавание фото»');
    if (res.status === 429) throw new UserError('Слишком много запросов к Claude API — подождите минуту');
    throw new UserError(`Claude API: ${msg}`);
  }
  if (body.stop_reason === 'refusal') throw new UserError('Не удалось распознать эту накладную. Попробуйте другое фото или введите строки вручную.');
  if (body.stop_reason === 'max_tokens') throw new UserError('Накладная слишком длинная — отправьте страницы по одной');
  const text = (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new UserError('Ответ распознавания не получилось разобрать — попробуйте ещё раз');
  }
}

module.exports = { recognize, apiKey, MODEL };
