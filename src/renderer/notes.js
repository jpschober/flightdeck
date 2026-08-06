// ---------------------------------------------------------------------------
// Notes / TODO (persisted per project)
// ---------------------------------------------------------------------------
import { $, escapeHtml } from './dom.js';
import { t } from './i18n.js';
import { sessions, activeId } from './sessions.js';
import { updateBadges } from './panel.js';
import { pulseWake } from './pulse.js';

const todoListEl = $('#todo-list');
export const todoInputEl = $('#todo-input');

export function renderTodos(s) {
  todoListEl.innerHTML = '';
  const todos = s ? s.todos : [];
  todoInputEl.disabled = !s;
  updateBadges(s);
  // A single funnel for both: note ticked off and session switched
  pulseWake();
  if (!todos.length) {
    todoListEl.innerHTML = `<div class="muted">${escapeHtml(t('notes.empty'))}</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  todos.forEach((todo, idx) => {
    const el = document.createElement('div');
    el.className = 'todo-item' + (todo.done ? ' done' : '');
    el.innerHTML = `
      <input type="checkbox" ${todo.done ? 'checked' : ''} title="${escapeHtml(t('notes.done'))}" />
      <span class="todo-text"></span>
      <button class="todo-del" title="${escapeHtml(t('notes.delete'))}" aria-label="${escapeHtml(t('notes.delete.aria'))}">✕</button>`;
    el.querySelector('.todo-text').textContent = todo.text;
    el.querySelector('input').addEventListener('change', (e) => {
      s.todos[idx].done = e.target.checked;
      saveTodos(s);
    });
    el.querySelector('.todo-del').addEventListener('click', () => {
      s.todos.splice(idx, 1);
      saveTodos(s);
    });
    frag.appendChild(el);
  });
  todoListEl.appendChild(frag);
}

export async function loadTodosFor(s) {
  if (!s) { renderTodos(null); return; }
  const res = await window.api.getTodos(s.id);
  if (!sessions.has(s.id)) return;
  s.todoKey = res.key;
  s.todos = res.todos;
  if (s.id === activeId) renderTodos(s);
}

async function saveTodos(s) {
  await window.api.setTodos(s.id, s.todos);
  if (s.id === activeId) renderTodos(s);
}

todoInputEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const s = activeId && sessions.get(activeId);
  const text = todoInputEl.value.trim();
  if (!s || !text) return;
  s.todos.push({ text, done: false, ts: Date.now() });
  todoInputEl.value = '';
  saveTodos(s);
});

window.api.onTodosChanged((key, todos) => {
  // another session in the same project changed the notes
  for (const s of sessions.values()) {
    if (s.todoKey === key && s.id !== activeId) s.todos = todos;
  }
  const active = activeId && sessions.get(activeId);
  if (active && active.todoKey === key) {
    active.todos = todos;
    renderTodos(active);
  }
});
