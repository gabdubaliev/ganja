'use strict';

// Цвет кружка расцветки по названию цвета у модификации («Тёмно-синий» → #1f2a44).
// Общий файл для витрины и конструктора. Свои цвета владелец задаёт в конструкторе (settings.colorMap) — они важнее.

const COLOR_WORDS = {
  'черный': '#1b1b1b', 'белый': '#ffffff', 'молочный': '#f3eee3', 'кремовый': '#f2e8d5', 'айвори': '#f4efe2', 'экрю': '#efe6d2',
  'бежевый': '#d9c7a7', 'песочный': '#cdb48c', 'кэмел': '#b98552', 'верблюжий': '#b98552', 'капучино': '#a88466', 'карамельный': '#b5733c',
  'хаки': '#7a7350', 'оливковый': '#5d6236', 'олива': '#5d6236', 'темно-зеленый': '#23412b', 'зеленый': '#2f6b3a', 'изумрудный': '#16795a',
  'мятный': '#a8dcc5', 'салатовый': '#9ccc4f', 'светло-серый': '#c9c9c9', 'темно-серый': '#4a4a4a', 'серый': '#8c8c8c', 'графит': '#3a3d42',
  'антрацит': '#2f3033', 'меланж': '#a7a7a7', 'темно-синий': '#1f2a44', 'синий': '#2349a8', 'голубой': '#8ec5ea', 'индиго': '#3b3f8f',
  'джинсовый': '#4a6a92', 'деним': '#4a6a92', 'бирюзовый': '#2bb3b1', 'красный': '#c8102e', 'бордовый': '#6d1a2a', 'вишневый': '#7b1e2b',
  'винный': '#6a1f30', 'розовый': '#f1a7b8', 'пудровый': '#e8c4c0', 'фиолетовый': '#6b3fa0', 'лиловый': '#b49ad1', 'сиреневый': '#c8a2d6',
  'желтый': '#f2c230', 'горчичный': '#c99a2e', 'оранжевый': '#e8742a', 'терракотовый': '#b55a3c', 'кирпичный': '#a2492f',
  'коричневый': '#6b4a32', 'шоколадный': '#4a2f22', 'золотой': '#c9a84a', 'серебристый': '#c0c0c0',
  'black': '#1b1b1b', 'white': '#ffffff', 'off white': '#f3eee3', 'grey': '#8c8c8c', 'gray': '#8c8c8c', 'navy': '#1f2a44', 'blue': '#2349a8',
  'red': '#c8102e', 'green': '#2f6b3a', 'olive': '#5d6236', 'khaki': '#7a7350', 'beige': '#d9c7a7', 'brown': '#6b4a32', 'pink': '#f1a7b8',
  'yellow': '#f2c230', 'orange': '#e8742a', 'purple': '#6b3fa0',
};
const COLOR_KEYS = Object.keys(COLOR_WORDS).sort((a, b) => b.length - a.length);
const normColor = (name) => String(name || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

// Свойство «Цвет» у товара: «Цвет», «Расцветка», «Color».
const isColorOption = (name) => /цвет|расцв|colou?r/i.test(String(name || ''));

// '#rrggbb', 'multi' (разноцветный) или null, если цвет не узнали.
function colorHex(name, map = {}) {
  const own = map[name] || map[normColor(name)];
  if (own) return own;
  const n = normColor(name);
  if (/мульти|разноцвет|принт|multi/.test(n)) return 'multi';
  if (COLOR_WORDS[n]) return COLOR_WORDS[n];
  const key = COLOR_KEYS.find((k) => n.includes(k));
  return key ? COLOR_WORDS[key] : null;
}

// Фон кружка: цвет, радуга для «мульти» или нейтральный узор, если цвет неизвестен.
function swatchBg(name, map) {
  const c = colorHex(name, map);
  if (c === 'multi') return 'conic-gradient(#e8742a, #f2c230, #2f6b3a, #2349a8, #6b3fa0, #c8102e, #e8742a)';
  return c || 'repeating-linear-gradient(45deg, #d9d9d9 0 4px, #f2f2f2 4px 8px)';
}
