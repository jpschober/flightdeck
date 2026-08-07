// ---------------------------------------------------------------------------
// Notes / TODO (persisted per project)
//
// The list is updated instead of built again: ticking a note off would
// otherwise replace the checkbox that received the click while it holds the
// focus. A row is found again by its note's id, which the main process mints
// and stores - see withIds in main/todos.js.
// ---------------------------------------------------------------------------
import { $, setText, setTitle, syncChildren } from './dom.js';
import { t, onLocaleChange } from './i18n.js';
import { sessions, activeId } from './sessions.js';
import { updateBadges, onPanelTab } from './panel.js';
import { pulseWake } from './pulse.js';

const todoListEl = $('#todo-list');
const todoInputEl = $('#todo-input');

export function renderTodos(s) {
  const todos = s ? s.todos : [];
  todoInputEl.disabled = !s;
  updateBadges(s);
  // A single funnel for both: note ticked off and session switched
  pulseWake();
  syncChildren(todoListEl, todoItems(todos), buildTodoItem, updateTodoItem);
}

/** The rows in the order they are shown, the empty notice as one of them. */
function todoItems(todos) {
  if (!todos.length) return [{ id: 'empty' }];
  return todos.map((todo) => ({ id: `todo:${todo.id}`, todo }));
}

function buildTodoItem(item) {
  const el = document.createElement('div');
  if (!item.todo) {
    el.className = 'muted';
    return el;
  }
  el.className = 'todo-item';
  el.innerHTML = `
    <input type="checkbox" />
    <span class="todo-text"></span>
    <button class="todo-del">✕</button>`;
  // The id, not the position: a note above this one can be deleted, and the
  // index the row was built at then points at someone else's note.
  const id = item.todo.id;
  el.querySelector('input').addEventListener('change', (e) => {
    withNote(id, (s, todo) => { todo.done = e.target.checked; saveTodos(s); });
  });
  el.querySelector('.todo-del').addEventListener('click', () => {
    withNote(id, (s, todo) => { s.todos.splice(s.todos.indexOf(todo), 1); saveTodos(s); });
  });
  return el;
}

function updateTodoItem(el, item) {
  const todo = item.todo;
  if (!todo) { setText(el, t('notes.empty')); return; }

  el.classList.toggle('done', Boolean(todo.done));
  const box = el.querySelector('input');
  box.checked = Boolean(todo.done);
  setTitle(box, t('notes.done'));
  setText(el.querySelector('.todo-text'), todo.text);

  const del = el.querySelector('.todo-del');
  setTitle(del, t('notes.delete'));
  del.setAttribute('aria-label', t('notes.delete.aria'));
}

// The session on screen at the moment of the click, and the note the row
// stands for. Both can be gone by then - the session was closed, the note was
// deleted in another window.
function withNote(id, fn) {
  const s = activeId && sessions.get(activeId);
  const todo = s && s.todos.find((x) => x.id === id);
  if (todo) fn(s, todo);
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
  // What comes back is what was stored, ids and all - a note just written has
  // none of its own yet.
  const stored = await window.api.setTodos(s.id, s.todos);
  if (!sessions.has(s.id)) return;
  if (stored) s.todos = stored;
  if (s.id === activeId) renderTodos(s);
}

// Whoever opens the tab wants to write a note.
onPanelTab('todos', (s) => { if (s) todoInputEl.focus(); });

onLocaleChange(() => renderTodos(activeId ? sessions.get(activeId) : null));

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
