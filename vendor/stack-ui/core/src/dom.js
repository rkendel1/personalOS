// Framework-free rendering of view trees into DOM nodes. Builds nodes with
// createElement / createTextNode / setAttribute only: it never parses markup
// or evaluates code. The built bundle must not even name those APIs, because
// Compute scans its served script for them literally (scripts/check-boundary.mjs).

import { Button, COMPONENTS, ConfirmAction, Dialog, ErrorPanel, Form, Select, TextField, isTree } from './view.js';

/// Render a view tree (or string, number, array, Node) to a DOM Node.
const SVG_NS = 'http://www.w3.org/2000/svg';

export function toDom(value, doc, ns) {
  const d = doc || document;
  if (value === null || value === undefined || value === false || value === true) return d.createDocumentFragment();
  if (typeof value === 'string' || typeof value === 'number') return d.createTextNode(String(value));
  if (Array.isArray(value)) {
    const fragment = d.createDocumentFragment();
    for (const item of value) fragment.appendChild(toDom(item, d, ns));
    return fragment;
  }
  if (isTree(value)) {
    // SVG (the brand mark) needs its namespace, inherited by its children.
    const space = value.t === 'svg' ? SVG_NS : ns;
    const element = space ? d.createElementNS(space, value.t) : d.createElement(value.t);
    for (const [key, attr] of Object.entries(value.a)) {
      if (attr === null || attr === undefined || attr === false) continue;
      element.setAttribute(key, attr === true ? '' : String(attr));
    }
    for (const [event, handler] of Object.entries(value.on || {})) element.addEventListener(event, handler);
    for (const child of value.c) element.appendChild(toDom(child, d, space));
    return element;
  }
  if (value && typeof value.nodeType === 'number') return value;
  throw new TypeError('toDom: unsupported child');
}

/// Moves focus to the shell's main landmark after a route change, so keyboard
/// and screen-reader users start at the new page's content.
export function focusMain(id, doc) {
  const d = doc || document;
  // The same normalisation Shell applies to its mainId.
  const main = d.getElementById(String(id || 'stack-main').replace(/[^A-Za-z0-9_-]/g, '-'));
  if (main && typeof main.focus === 'function') main.focus({ preventScroll: true });
}

/// Each component as a function returning a DOM element, e.g.
///   StackUI.dom.StatusIndicator({ field: 'compute.health', value: 'healthy' })
export const dom = Object.freeze(Object.fromEntries(
  Object.entries(COMPONENTS).map(([name, component]) => [name, (props, doc) => toDom(component(props || {}), doc)]),
));

// ---- Dialogs (PR4) -----------------------------------------------------------

/// Opens a rendered <dialog> as a modal and returns a function that closes it.
/// On close the dialog is removed and focus returns to whatever had it before
/// (normally the button that asked), as the dialog pattern requires.
export function openDialog(dialog, doc) {
  const d = doc || dialog.ownerDocument || document;
  const returnTo = d.activeElement;
  if (!dialog.isConnected) d.body.appendChild(dialog);
  dialog.showModal();
  let closed = false;
  return function close() {
    if (closed) return;
    closed = true;
    if (dialog.open) dialog.close();
    dialog.remove();
    if (returnTo && returnTo.isConnected && typeof returnTo.focus === 'function') returnTo.focus();
  };
}

const failureOf = (error) => ({
  message: error && error.message ? error.message : String(error),
  ...(error && error.code ? { code: String(error.code) } : {}),
  ...(error && error.requestId ? { requestId: String(error.requestId) } : {}),
});

/// Asks for confirmation with ConfirmAction and resolves `true` once the
/// action is done, or `false` if the person cancels. With `action` (an async
/// function) the dialog stays open while it runs, shows it as busy, and shows
/// its error in place if it fails, so the person can retry or cancel; the
/// dialog closes only after the product reports success.
export function confirmAction(props, doc) {
  const d = doc || document;
  let typed = '';
  let state = { busy: false, error: null };
  return new Promise((resolve) => {
    let dialog;
    let close;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      close();
      resolve(result);
    };
    const render = () => toDom(ConfirmAction({
      ...props,
      ...state,
      typed,
      onTypedChange: (value) => {
        typed = value;
        // This helper owns the DOM it built, so it updates the one attribute
        // that depends on the typed text rather than rebuilding the dialog.
        const confirm = dialog.querySelector('[data-dialog-confirm]');
        confirm.disabled = value !== props.requireText || state.busy;
      },
      onCancel: () => { if (!state.busy) finish(false); },
      // Confirm is handled by delegation below: the button's disabled state
      // changes as text is typed, without rebuilding it.
      onConfirm: undefined,
    }), d);
    const confirm = async () => {
      if (!props.action) { finish(true); return; }
      update({ busy: true, error: null });
      try {
        await props.action();
        finish(true);
      } catch (error) {
        update({ busy: false, error: failureOf(error) });
      }
    };
    const update = (next) => {
      state = next;
      const fresh = render();
      dialog.replaceChildren(...fresh.childNodes);
      for (const attr of Array.from(fresh.attributes)) dialog.setAttribute(attr.name, attr.value);
      const target = dialog.querySelector(state.error ? '[data-dialog-confirm]' : '[data-dialog-cancel]');
      if (target && !target.disabled) target.focus();
    };
    dialog = render();
    dialog.addEventListener('click', (event) => {
      const button = event.target.closest('[data-dialog-confirm]');
      if (button && !button.disabled && !state.busy) confirm();
    });
    // The browser may close a modal itself (a repeated Esc). While the action
    // runs the dialog is shown again; otherwise that is a cancel.
    dialog.addEventListener('close', () => {
      if (done) return;
      if (state.busy) dialog.showModal();
      else finish(false);
    });
    close = openDialog(dialog, d);
    const first = dialog.querySelector(filled(props.requireText) ? 'input' : '[data-dialog-cancel]');
    if (first) first.focus();
  });
}

// Named apart from view.js's helpers: the classic build shares one scope.
const filled = (value) => value !== null && value !== undefined && value !== '';

/// A dialog holding a short form of labelled fields (the replacement for
/// `prompt()`). Resolves with the submitted values once `action(values)`
/// succeeds, or `null` if the person cancels. While `action` runs the submit
/// button is busy; its error is shown in the dialog.
export function formDialog(props, doc) {
  const d = doc || document;
  const id = String(props.id || 'stack-form-dialog').replace(/[^A-Za-z0-9_-]/g, '-');
  return new Promise((resolve) => {
    let close;
    let busy = false;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      close();
      resolve(result);
    };
    const dialog = toDom(Dialog({
      id,
      title: props.title,
      description: props.description,
      className: 'stack-form-dialog',
      onClose: () => { if (!busy) finish(null); },
    }), d);
    const body = d.createElement('div');
    body.className = 'stack-dialog__body';
    const errorSlot = d.createElement('div');
    const renderForm = () => toDom(Form({
      id: `${id}-form`,
      submitLabel: props.submitLabel || 'Save',
      busy,
      actions: Button({ label: props.cancelLabel || 'Cancel', variant: 'ghost', disabled: busy, onClick: () => { if (!busy) finish(null); }, attrs: { 'data-dialog-cancel': 'true' } }),
      children: (props.fields || []).map((fieldProps, index) => (fieldProps.options
        ? Select({ id: `${id}-field-${index}`, ...fieldProps })
        : TextField({ id: `${id}-field-${index}`, ...fieldProps }))),
      onSubmit: async (event) => {
        const values = Object.fromEntries(new FormData(event.target));
        if (!props.action) { finish(values); return; }
        busy = true;
        setBusy(event.target, true);
        errorSlot.replaceChildren();
        try {
          await props.action(values);
          finish(values);
        } catch (error) {
          busy = false;
          setBusy(event.target, false);
          errorSlot.replaceChildren(toDom(ErrorPanel({ title: 'Not saved', ...failureOf(error) }), d));
          event.target.querySelector('button[type="submit"]').focus();
        }
      },
    }), d);
    // Busy state without rebuilding the form, so typed values stay put.
    const setBusy = (form, value) => {
      for (const control of form.querySelectorAll('input, select, textarea, button')) control.disabled = value;
      const submit = form.querySelector('button[type="submit"]');
      if (value) submit.setAttribute('aria-busy', 'true'); else submit.removeAttribute('aria-busy');
    };
    body.append(errorSlot, renderForm());
    dialog.querySelector('.stack-dialog__surface').appendChild(body);
    dialog.addEventListener('close', () => {
      if (done) return;
      if (busy) dialog.showModal();
      else finish(null);
    });
    close = openDialog(dialog, d);
    const first = dialog.querySelector('input, select, textarea');
    if (first) first.focus();
  });
}
