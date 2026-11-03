'use strict';

// MONT AI Studio + Claude: проверка исходных фото (набор, резкость, кадр, свет), описание вещи по фото
// и сравнение результата генерации с оригиналом — вместо ручной проверки по списку.
// Claude только смотрит и проверяет; новые картинки он не рисует (генерация — ChatGPT, позже Gemini).

const { askJson } = require('./invoice');
const prompts = require('./studio-prompts');

// Обязательный набор исходных фото: спереди, сзади, деталь крупно, бирка или логотип (бренд).
const REQUIRED = [
  { key: 'front', label: 'спереди', roles: ['front'] },
  { key: 'back', label: 'сзади', roles: ['back'] },
  { key: 'detail', label: 'деталь крупно', roles: ['detail', 'fabric'] },
  { key: 'brand', label: 'бирка или логотип (бренд)', roles: ['label', 'print'] },
];
function missingRoles(sources) {
  const have = new Set(sources.map((a) => a.role));
  return REQUIRED.filter((r) => !r.roles.some((x) => have.has(x)));
}

const ROLE_KEYS = Object.keys(prompts.ROLES);
const str = (description) => ({ type: 'string', description });
const bool = (description) => ({ type: 'boolean', description });
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

const SOURCES_SCHEMA = obj({
  photos: {
    type: 'array',
    items: obj({
      id: { type: 'integer', description: 'Номер фото из подписи' },
      seen_as: { type: 'string', enum: ROLE_KEYS, description: 'Что на самом деле на фото' },
      role_ok: bool('Подпись (роль) совпадает с тем, что на фото'),
      sharp: bool('Фото резкое, не смазано'),
      whole_item: bool('Для «спереди/сзади/сбоку» — вещь целиком в кадре; для детали и бирки — нужная часть видна чётко'),
      light_ok: bool('Свет ровный, цвет не искажён, нет сильных бликов и пересвета'),
      ok: bool('Фото годится как исходник'),
      problem: str('Если не годится — что переснять, коротко и по-русски, иначе пусто'),
    }),
  },
  ready: bool('Набор годится: есть спереди, сзади, деталь, бирка/логотип, и все фото годятся'),
  summary: str('Итог одной-двумя фразами по-русски'),
  item: obj({
    type: str('Вид вещи: кардиган, футболка, джинсы…'),
    color: str('Цвет по-русски, как назвал бы продавец'),
    color_hex: str('Основной цвет в виде #RRGGBB'),
    material: str('Ткань или материал на вид (и по бирке, если видно)'),
    fit: str('Крой и посадка'),
    closure: str('Застёжка: на молнии, на пуговицах, без застёжки…'),
    details: { type: 'array', items: { type: 'string' }, description: 'Важные детали: карманы, швы, принты, логотипы, манжеты' },
    brand: str('Бренд с бирки или логотипа, если читается, иначе пусто'),
    label_text: str('Что написано на бирке (состав, размер), если читается'),
    description: str('Описание для интернет-витрины по-русски, 2–4 предложения, без выдумок — только то, что видно'),
  }),
});

function sourcesPrompt(facts, list) {
  return `Ты проверяешь исходные фото одежды для интернет-магазина мужской одежды MONT перед обработкой (фон, модель, реклама).
Товар в программе: «${facts.name}»${facts.category ? `, категория «${facts.category}»` : ''}${Object.keys(facts.options || {}).length ? `, ${Object.entries(facts.options).map(([k, v]) => `${k}: ${v}`).join(', ')}` : ''}.
Фото подписаны так: ${list.map((a) => `№${a.id} — ${prompts.ROLES[a.role] || 'другое'}`).join('; ')}.
Нужен набор: спереди, сзади, деталь крупно (ткань, фурнитура, шов), бирка или логотип (бренд).
Для каждого фото проверь: совпадает ли подпись с содержимым, резкость, кадр, свет. Будь строгим, но не придирайся к мелочам — фото с телефона в магазине.
Опиши вещь только по тому, что видно на фото. Ничего не выдумывай: не видно состава — не пиши его.
Ответ — только JSON по схеме.`;
}

async function checkSources(store, { facts, images }, UserError) {
  if (!images.length) throw new UserError('Загрузите исходные фото');
  const content = [];
  for (const im of images) {
    content.push({ type: 'text', text: `Фото №${im.id} (подпись: ${prompts.ROLES[im.role] || 'другое'})` });
    content.push({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } });
  }
  content.push({ type: 'text', text: sourcesPrompt(facts, images) });
  return askJson(store, { content, schema: SOURCES_SCHEMA, effort: 'medium', what: 'Проверка фото' }, UserError);
}

// Сравнение результата с оригиналом — по тем же пунктам, что видит человек в окне «Сравнить».
function resultSchema(checklist) {
  return obj({
    checks: obj(Object.fromEntries(Object.entries(checklist).map(([k, label]) => [k, obj({ ok: bool(label), note: str('Если не совпадает — что именно, по-русски, иначе пусто') })]))),
    quality: obj({ ok: bool('Нет артефактов: лишних пальцев, искажённых лиц, «поплывших» надписей, обрезанной вещи'), note: str('Что не так с качеством, иначе пусто') }),
    verdict: { type: 'string', enum: ['ok', 'redo'], description: 'ok — можно в галерею; redo — переделать' },
    redo_note: str('Если redo — чёткое указание для повторной генерации по-русски: что исправить и что сохранить'),
    summary: str('Итог одной фразой по-русски'),
  });
}

async function checkResult(store, { facts, task, checklist, result, originals }, UserError) {
  if (!originals.length) throw new UserError('Нет оригиналов для сравнения');
  const content = [];
  for (const o of originals) {
    content.push({ type: 'text', text: `ОРИГИНАЛ №${o.id} (${prompts.ROLES[o.role] || 'фото'})` });
    content.push({ type: 'image', source: { type: 'base64', media_type: o.mime, data: o.data } });
  }
  content.push({ type: 'text', text: 'РЕЗУЛЬТАТ ГЕНЕРАЦИИ (проверяемое фото)' });
  content.push({ type: 'image', source: { type: 'base64', media_type: result.mime, data: result.data } });
  content.push({ type: 'text', text: `Ты — строгий проверяющий фото одежды для интернет-магазина MONT. Сравни РЕЗУЛЬТАТ с ОРИГИНАЛАМИ.
Товар: «${facts.name}»${Object.keys(facts.options || {}).length ? ` (${Object.entries(facts.options).map(([k, v]) => `${k}: ${v}`).join(', ')})` : ''}. Задание было: ${task ? prompts.OPERATIONS[task.operation] || task.operation : 'обработка фото'}.
Вещь на результате должна быть ТОЙ ЖЕ САМОЙ: цвет и оттенок, ткань, крой, длина, карманы, пуговицы, молнии, швы, принты, надписи и логотипы — без изменений и без добавлений.
Фон, модель, поза, свет могут отличаться — это и было задание. Покупатель не должен получить вещь, отличную от фото.
Если хоть один пункт не совпадает или есть явный артефакт — verdict = redo и в redo_note напиши, что исправить.
Ответ — только JSON по схеме.` });
  return askJson(store, { content, schema: resultSchema(checklist), effort: 'high', what: 'Проверка результата' }, UserError);
}

module.exports = { REQUIRED, missingRoles, checkSources, checkResult };
