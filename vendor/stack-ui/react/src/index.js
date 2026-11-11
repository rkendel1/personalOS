'use client';
// React 18/19 binding for @stack-ui/core. Renders the same view trees as
// @stack-ui/core/dom, so a component's DOM is identical in React and
// framework-free pages. No build step: plain ES modules over React.createElement.
// 'use client' lets React Server Components frameworks (Next.js) import it
// from server components: the components still render on the server.
import { cloneElement, createElement, Fragment, isValidElement, useEffect, useRef, useState } from 'react';
import { COMPONENTS, isTree } from '@stack-ui/core/view';

const RENAMED = {
  class: 'className', for: 'htmlFor', datetime: 'dateTime', tabindex: 'tabIndex',
  readonly: 'readOnly', autocomplete: 'autoComplete', inputmode: 'inputMode', maxlength: 'maxLength',
  minlength: 'minLength', spellcheck: 'spellCheck',
};
const EVENTS = { click: 'onClick', change: 'onChange', input: 'onInput', submit: 'onSubmit', keydown: 'onKeyDown', cancel: 'onCancel', close: 'onClose' };

/// Render a view tree (or string, array, React element) as React nodes.
export function toReact(value, key) {
  if (value === null || value === undefined || value === false || value === true) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (Array.isArray(value)) {
    return createElement(Fragment, key === undefined ? null : { key }, ...value.map((item, index) => toReact(item, index)));
  }
  if (isValidElement(value)) return key === undefined ? value : createElement(Fragment, { key }, value);
  if (isTree(value)) {
    const identity = value.k === undefined ? key : value.k;
    const props = identity === undefined ? {} : { key: identity };
    for (const [name, attr] of Object.entries(value.a)) {
      if (attr === null || attr === undefined || attr === false) continue;
      props[RENAMED[name] || name] = attr;
    }
    const control = value.t === 'input' || value.t === 'select' || value.t === 'textarea';
    for (const [event, handler] of Object.entries(value.on || {})) {
      if (!EVENTS[event]) throw new Error(`toReact: unsupported event ${event}`);
      // React form controls report every edit through onChange.
      props[control && (event === 'input' || event === 'change') ? 'onChange' : EVENTS[event]] = handler;
    }
    let childTrees = value.c;
    if (value.t === 'textarea') {
      // React sets a textarea's text through value, never children.
      props.value = childTrees.filter((child) => typeof child === 'string' || typeof child === 'number').join('');
      childTrees = [];
    }
    if (value.t === 'select') {
      // React selects by the select's value, not an option's `selected`.
      const chosen = childTrees.find((child) => isTree(child) && child.t === 'option' && child.a.selected);
      childTrees = childTrees.map((child) => (isTree(child) && child.t === 'option' && child.a.selected
        ? { ...child, a: { ...child.a, selected: false } } : child));
      if (chosen) props.value = chosen.a.value;
    }
    if (control && 'checked' in props && !props.onChange) {
      // An uncontrolled checkbox: React must not freeze it either.
      props.defaultChecked = props.checked;
      delete props.checked;
    }
    if (control && 'value' in props && !props.onChange) {
      // Without a handler the control is uncontrolled; React must not freeze it.
      props.defaultValue = props.value;
      delete props.value;
    }
    const children = childTrees.map((child, index) => toReact(child, index));
    return createElement(value.t, props, ...children);
  }
  throw new TypeError('toReact: unsupported child');
}

const bind = (name) => {
  const component = COMPONENTS[name];
  const Bound = (props) => toReact(component(props || {}));
  Bound.displayName = `Stack${name}`;
  return Bound;
};

export const StatusIndicator = bind('StatusIndicator');
export const VerificationBadge = bind('VerificationBadge');
export const FreshnessLabel = bind('FreshnessLabel');
export const Unavailable = bind('Unavailable');
export const Loading = bind('Loading');
export const EmptyState = bind('EmptyState');
export const ErrorPanel = bind('ErrorPanel');
export const MetadataList = bind('MetadataList');
export const ResourceIdentity = bind('ResourceIdentity');
export const PageHeader = bind('PageHeader');
export const Button = bind('Button');
export const Breadcrumbs = bind('Breadcrumbs');
export const Tabs = bind('Tabs');
export const TabPanel = bind('TabPanel');
export const DataTable = bind('DataTable');
export const FilterBar = bind('FilterBar');
export const Pagination = bind('Pagination');
export const Shell = bind('Shell');
export const TextField = bind('TextField');
export const Select = bind('Select');
export const Form = bind('Form');
export const EvidenceSummary = bind('EvidenceSummary');
export const Alert = bind('Alert');
export const Checkbox = bind('Checkbox');
export const FieldGroup = bind('FieldGroup');
export const ActivityTimeline = bind('ActivityTimeline');
export const BrandMark = bind('BrandMark');
export const ThemeSwitch = bind('ThemeSwitch');
export const SiteHeader = bind('SiteHeader');
export const SiteFooter = bind('SiteFooter');

/// Opens the rendered <dialog> as a modal while `open` is true. If the browser
/// closes it by itself while it should be open (a repeated Esc), a busy
/// dialog is shown again and any other calls `onDismiss`, so the product's
/// `open` never disagrees with the screen. The browser returns focus to the
/// element that had it when the dialog closes.
function useModal(open, onDismiss, busy) {
  const ref = useRef(null);
  const latest = useRef({ open, onDismiss, busy });
  latest.current = { open, onDismiss, busy };
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;
    const closed = () => {
      const now = latest.current;
      if (!now.open) return;
      if (now.busy) dialog.showModal();
      else if (now.onDismiss) now.onDismiss();
    };
    dialog.addEventListener('close', closed);
    return () => dialog.removeEventListener('close', closed);
  }, []);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  return ref;
}

/// A modal dialog: the shared Dialog structure, shown while `open` is true.
/// Esc calls `onClose`; the product decides whether to set `open` to false.
export function Dialog(props) {
  const ref = useModal(Boolean(props.open), props.onClose, !props.onClose);
  return cloneElement(toReact(COMPONENTS.Dialog(props)), { ref });
}
Dialog.displayName = 'StackDialog';

/// ConfirmAction as a modal shown while `open` is true. It keeps the typed
/// confirmation text itself unless the product passes `typed`. While `busy`,
/// Esc does nothing and the dialog stays open.
export function ConfirmAction(props) {
  const ref = useModal(Boolean(props.open), props.onCancel, Boolean(props.busy));
  const [typed, setTyped] = useState('');
  useEffect(() => { if (!props.open) setTyped(''); }, [props.open]);
  const controlled = props.typed !== undefined;
  return cloneElement(toReact(COMPONENTS.ConfirmAction({
    ...props,
    typed: controlled ? props.typed : typed,
    onTypedChange: controlled ? props.onTypedChange : setTyped,
  })), { ref });
}
ConfirmAction.displayName = 'StackConfirmAction';
export {
  readThemePreference, storeThemePreference, applyThemePreference, initThemePreference, setThemePreference,
  THEME_PREFERENCES, THEME_STORAGE_KEY, THEME_INIT_SCRIPT,
} from '@stack-ui/core/theme';
export { PORTFOLIO, portfolioProduct } from '@stack-ui/core/brand';

export { resolve, verification, verificationOf, freshnessOf, capability, humanize, TONES, GLYPHS } from '@stack-ui/core/states';
export { focusMain, openDialog, confirmAction, formDialog } from '@stack-ui/core/dom';
