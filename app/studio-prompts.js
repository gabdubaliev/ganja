'use strict';

// MONT AI Studio: тексты заданий (промптов) для ChatGPT. Генерацию делает сам владелец в ChatGPT вручную —
// здесь только текст задания из данных товара и выбранных параметров. Никаких запросов к внешним сервисам.

const OPERATIONS = {
  background: 'Удалить или заменить фон',
  catalog: 'Каталожное фото',
  model: 'Надеть на модель',
  ad: 'Рекламное изображение',
  details: 'Детальное фото для витрины',
};
// Что показать крупным планом (детальные фото).
const DETAILS = {
  fabric: 'фактура ткани',
  seams: 'швы и отстрочка',
  buttons: 'пуговицы, кнопки или молния',
  pockets: 'карманы',
  print: 'принт, надпись или логотип',
  collar: 'воротник, манжеты или пояс',
  label: 'бирка или этикетка',
};
const ROLES = { front: 'спереди', back: 'сзади', side: 'сбоку', detail: 'деталь', fabric: 'ткань крупно', print: 'принт или логотип', label: 'бирка', other: 'другое' };
const BACKGROUNDS = {
  white: 'чистый белый однотонный фон (#FFFFFF)',
  light: 'светло-серый однотонный фон (#F2F2F2)',
  beige: 'тёплый светло-бежевый однотонный фон (#EFE9E1)',
  transparent: 'прозрачный фон (PNG с прозрачностью)',
};
const ASPECTS = { '3:4': '3:4, вертикальный', '4:5': '4:5, вертикальный', '1:1': '1:1, квадрат', '9:16': '9:16, вертикальный во весь экран телефона' };
const GENDERS = { male: 'мужчина', female: 'женщина' };
const AGES = { '18-25': '18–25 лет', '25-35': '25–35 лет', '35-50': '35–50 лет' };
const BUILDS = { slim: 'стройное', regular: 'обычное', athletic: 'спортивное', large: 'крупное' };
const POSES = { standing: 'стоит прямо, руки свободно опущены', walking: 'идёт, естественный шаг', relaxed: 'стоит расслабленно, одна рука в кармане брюк (не в кармане товара)', seated: 'сидит на простом стуле' };
const FRAMINGS = { full: 'в полный рост', waist: 'по пояс (если товар — верх)', knees: 'до колен' };
const SETTINGS = { studio: 'студия с однотонным фоном', street: 'спокойная городская улица днём, фон размыт', interior: 'светлый современный интерьер, фон размыт' };
const PLATFORMS = { post: { label: 'пост в Instagram', aspect: '4:5' }, story: { label: 'сторис / Reels', aspect: '9:16' }, square: { label: 'квадратный пост', aspect: '1:1' } };
const AD_STYLES = { minimal: 'минимализм: много воздуха, спокойные цвета, акцент на вещи', street: 'уличный стиль: город, живой свет', premium: 'премиум: мягкий контрастный свет, глубокие тени, дорогая подача', bright: 'яркий: насыщенный цветной фон, динамично' };

const pick = (map, key, fallback) => (Object.hasOwn(map, key) ? key : fallback);
const clean = (v, max) => String(v ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const hex = (v) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toUpperCase() : null);

// Параметры задания: только известные значения, остальное — по умолчанию.
function normalizeParams(operation, p = {}) {
  const bg = hex(p.bgColor) ? 'custom' : pick(BACKGROUNDS, p.background, operation === 'model' || operation === 'ad' ? 'light' : 'white');
  const out = {
    background: bg,
    bgColor: bg === 'custom' ? hex(p.bgColor) : null,
    aspect: pick(ASPECTS, p.aspect, '3:4'),
    note: clean(p.note, 400),
  };
  if (operation === 'model') {
    Object.assign(out, {
      gender: pick(GENDERS, p.gender, 'male'),
      age: pick(AGES, p.age, '25-35'),
      build: pick(BUILDS, p.build, 'regular'),
      pose: pick(POSES, p.pose, 'standing'),
      framing: pick(FRAMINGS, p.framing, 'full'),
      setting: pick(SETTINGS, p.setting, 'studio'),
    });
    if (out.background === 'transparent') out.background = 'light';
  }
  if (operation === 'details') {
    out.detail = pick(DETAILS, p.detail, 'fabric');
    out.aspect = pick(ASPECTS, p.aspect, '1:1');
    if (out.background === 'transparent') out.background = 'white';
  }
  if (operation === 'ad') {
    const platform = pick(PLATFORMS, p.platform, 'post');
    Object.assign(out, {
      platform,
      aspect: PLATFORMS[platform].aspect,
      style: pick(AD_STYLES, p.style, 'minimal'),
      withModel: p.withModel === true || p.withModel === '1' || p.withModel === 'true',
      headline: clean(p.headline, 60),
      price: clean(p.price, 30),
    });
    if (out.background === 'transparent') out.background = 'light';
  }
  return out;
}

// Неизменность вещи — главное требование для любой операции.
const KEEP = [
  'цвет и оттенок ткани — точно как на фото: не светлее, не темнее, не другой тон; фактура и плотность ткани те же',
  'крой и посадка, длина изделия, длина рукавов и брючин — как на фото',
  'карманы — то же количество, та же форма и то же расположение',
  'пуговицы, молнии, кнопки, швы и отстрочка — то же количество, тот же цвет и то же расположение',
  'принты, надписи и логотипы — без изменений: не перерисовывать, не переводить, не исправлять, не добавлять новых',
  'ничего не добавлять и не убирать: никаких новых деталей, нашивок, складок «для красоты», украшений',
  'если какую-то деталь не видно на фото — не придумывай её',
];

function productLines(product) {
  const lines = [`Товар: ${clean(product.name, 200)}.`];
  if (product.category) lines.push(`Категория: ${clean(product.category, 80)}.`);
  const opts = Object.entries(product.options || {}).filter(([, v]) => v);
  if (opts.length) lines.push(`Модификация: ${opts.map(([k, v]) => `${clean(k, 40)} — ${clean(v, 60)}`).join(', ')}.`);
  if (product.description) lines.push(`Описание от магазина: ${clean(product.description, 600)}`);
  return lines;
}

function bgText(params) {
  return params.background === 'custom' ? `однотонный фон цвета ${params.bgColor}` : BACKGROUNDS[params.background];
}

// product: { name, category, description, options: {Цвет, Размер…} }, sources: [{ role }] — по порядку, как приложены фото.
function buildPrompt(operation, rawParams, product, sources) {
  if (!OPERATIONS[operation]) throw new Error('Неизвестная операция');
  const params = normalizeParams(operation, rawParams);
  const photoList = sources.length
    ? `Приложенные фото (${sources.length}): ${sources.map((s, i) => `${i + 1} — ${ROLES[s.role] || 'фото'}`).join('; ')}.`
    : 'Фото товара приложены.';
  const keepBlock = ['Самое важное — вещь должна остаться ТОЧНО такой же, как на приложенных фото:', ...KEEP.map((k) => `- ${k};`)].join('\n');
  const tail = [];
  if (params.note) tail.push(`Дополнительно: ${params.note}`);
  tail.push('Сделай одно изображение высокого качества. Без водяных знаков и рамок.');
  let task;
  let scene;
  if (operation === 'background') {
    task = 'Задача: аккуратно отделить вещь от фона и поставить её на новый фон для каталога интернет-магазина мужской одежды MONT.';
    scene = [
      `Фон: ${bgText(params)}.`,
      'Края вещи — чистые и точные, без ореола, без «съеденных» деталей (рукава, воротник, шнурки, бирки, бахрома).',
      'Саму вещь не перерисовывай и не «улучшай»: меняется только фон. Тень — лёгкая и естественная, или без тени, если фон прозрачный.',
      `Соотношение сторон: ${ASPECTS[params.aspect]}. Вещь целиком в кадре, по центру, с небольшими полями.`,
      'Без текста на изображении.',
    ];
  } else if (operation === 'catalog') {
    task = 'Задача: подготовить каталожное фото товара для интернет-магазина мужской одежды MONT из приложенных фото.';
    scene = [
      'Подача: вещь ровно, без перекосов, аккуратно расправлена (раскладка или манекен-невидимка), как в каталогах крупных магазинов одежды.',
      'Свет: равномерный мягкий студийный, без пересветов и глубоких теней; цвет передан точно.',
      'Можно убрать пыль, ворсинки и случайные заломы, но не менять форму, крой и фактуру.',
      `Фон: ${bgText(params)}.`,
      `Соотношение сторон: ${ASPECTS[params.aspect]}. Вещь целиком в кадре, по центру.`,
      'Без текста на изображении.',
    ];
  } else if (operation === 'model') {
    task = 'Задача: показать эту вещь на виртуальной модели для каталога интернет-магазина мужской одежды MONT.';
    scene = [
      `Модель: вымышленный человек (не известная личность), ${GENDERS[params.gender]}, ${AGES[params.age]}, ${BUILDS[params.build]} телосложение; естественное лицо и кожа.`,
      `Поза: ${POSES[params.pose]}. Кадр: ${FRAMINGS[params.framing]}.`,
      'Посадка вещи на фигуре — реалистичная для этого размера: не делай её уже, длиннее или короче, чем она есть.',
      'Остальная одежда — простая, нейтральных цветов, не перекрывает и не отвлекает от товара.',
      `Место: ${SETTINGS[params.setting]}${params.setting === 'studio' ? `, ${bgText(params)}` : ''}. Свет мягкий, цвет вещи передан точно.`,
      `Соотношение сторон: ${ASPECTS[params.aspect]}.`,
      'Без текста на изображении.',
    ];
  } else if (operation === 'details') {
    task = `Задача: детальное фото для карточки товара интернет-магазина мужской одежды MONT — крупный план: ${DETAILS[params.detail]}.`;
    scene = [
      'Это должен быть крупный план РЕАЛЬНОЙ детали, которая видна на приложенных фото. Используй только то, что есть на фото.',
      'Если нужная деталь на фото не видна или нечёткая — не придумывай и не дорисовывай её, а напиши об этом текстом вместо картинки.',
      'Разрешено только: кадрирование, увеличение, выравнивание, ровный свет, чёткость. Запрещено: менять цвет, фактуру, рисунок ткани, форму и количество деталей, добавлять новые элементы.',
      'Число пуговиц, отверстий в них, стежков, зубцов молнии, буквы надписей и элементы логотипа — точно как на фото.',
      `Фон вокруг детали (если он виден): ${bgText(params)}.`,
      `Соотношение сторон: ${ASPECTS[params.aspect]}.`,
      'Без текста на изображении.',
    ];
  } else {
    const pl = PLATFORMS[params.platform];
    task = `Задача: рекламное изображение для соцсетей (${pl.label}) магазина мужской одежды MONT с этой вещью.`;
    scene = [
      `Стиль: ${AD_STYLES[params.style]}.`,
      params.withModel
        ? 'Вещь — на вымышленной модели (не известная личность), мужчина 25–35 лет, естественная поза.'
        : 'Вещь — без модели: красивая раскладка или на вешалке, в продуманной композиции.',
      params.headline || params.price
        ? `Текст на изображении, крупно и без ошибок, на русском: ${[params.headline && `«${params.headline}»`, params.price && `цена «${params.price}»`].filter(Boolean).join(', ')}. Других надписей не добавляй.`
        : 'Без текста на изображении — текст добавим сами.',
      'Логотип магазина не рисуй — добавим сами. Оставь немного свободного места сверху или снизу.',
      `Соотношение сторон: ${ASPECTS[params.aspect]}.`,
    ];
  }
  const prompt = [task, '', ...productLines(product), photoList, '', keepBlock, '', ...scene, '', ...tail].join('\n');
  return { prompt, params };
}

// Повторная генерация после отклонения: исходное задание целиком (все требования к товару остаются)
// + замечания по всем прошлым попыткам + что было верно. corrections: [{ attempt, note }] — по порядку.
function buildRetryPrompt({ basePrompt, attempt, corrections, keepOk = [], withPrevious = false }) {
  const lines = [
    String(basePrompt || '').trim(),
    '',
    `ИСПРАВЛЕНИЯ — попытка ${attempt}. Предыдущий результат не подошёл.`,
    'Все требования из задания выше остаются в силе. Дополнительно исправь замечания:',
    ...corrections.map((c, i) => `${i + 1}. ${clean(c.note, 500)}${corrections.length > 1 ? ` (замечание к попытке ${c.attempt})` : ''}`),
  ];
  if (keepOk.length) lines.push(`В прошлом результате было верно — сохрани: ${keepOk.join('; ')}.`);
  if (withPrevious) lines.push('Если приложен отклонённый прошлый результат — он только для того, чтобы понять, что исправить. Образец вещи — исходные фото товара, а не прошлый результат.');
  lines.push('Не вноси никаких других изменений, кроме перечисленных исправлений. Сделай одно новое изображение.');
  return lines.join('\n');
}

// Короткая поправка, если продолжаете в том же чате ChatGPT.
function buildFollowup({ note, keepOk = [] }) {
  return [
    `Этот результат не подходит. Исправь: ${clean(note, 500)}`,
    keepOk.length ? `Это было верно — оставь как есть: ${keepOk.join('; ')}.` : '',
    'Все требования из первого сообщения остаются: вещь точно как на исходных фото — цвет, ткань, крой, длина, карманы, пуговицы, молнии, швы, принты и логотипы; ничего не добавляй и не придумывай.',
    'Сделай новое изображение.',
  ].filter(Boolean).join('\n');
}

module.exports = { buildRetryPrompt, buildFollowup, buildPrompt, normalizeParams, OPERATIONS, DETAILS, ROLES, BACKGROUNDS, ASPECTS, GENDERS, AGES, BUILDS, POSES, FRAMINGS, SETTINGS, PLATFORMS, AD_STYLES, KEEP };
