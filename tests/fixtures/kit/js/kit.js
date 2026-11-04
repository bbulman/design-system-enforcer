/* Kit's components drawn in JavaScript, each the twin of its kit_* helper: kit.button() is kit_button(). */
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const kit = {
  button: (text, o = {}) => `<button class="kit-btn kit-btn--${o.variant || 'primary'}" type="button">${esc(text)}</button>`,
  badge: (text, o = {}) => `<span class="kit-badge kit-badge--${o.variant || 'default'}">${esc(text)}</span>`,
  pill: text => `<span class="kit-pill">${esc(text)}</span>`,
  alert: (message, o = {}) => `<div class="kit-alert kit-alert--${o.variant || 'info'}" role="status">${esc(message)}</div>`,
  input: (name, o = {}) => `<div class="kit-field"><input class="kit-input" name="${esc(name)}" type="${o.type || 'text'}"></div>`,
  select: name => `<div class="kit-field"><select class="kit-select" name="${esc(name)}"></select></div>`,
  tabs: () => '<div class="kit-tabs" role="tablist"></div>',
  emptyState: title => `<div class="kit-empty-state"><h3>${esc(title)}</h3></div>`,
  card: content => `<div class="kit-card">${content}</div>`,
};
