import type { ReactElement, ReactNode } from 'react';

export type Tone = 'positive' | 'progress' | 'attention' | 'critical' | 'neutral' | 'unknown';
export type VerificationState = 'verified' | 'verification_failed' | 'not_verified' | 'not_evaluated';
export type Freshness = 'live' | 'cached' | 'stale' | 'unknown';
export type Check = string | { label: string; status?: 'passed' | 'failed' };
type Passthrough = { className?: string; attrs?: Record<string, string | number | boolean | null | undefined> };

export interface StatusIndicatorProps extends Passthrough {
  /** A mapped source field, e.g. "compute.health". Resolves tone and default label. */
  field?: string;
  value?: string | number | boolean;
  tone?: Tone;
  label?: string;
  glyph?: string;
  detail?: ReactNode;
}
export interface VerificationBadgeProps extends Passthrough {
  state: VerificationState;
  checks?: Check[];
  at?: string | number | Date;
  evidenceHref?: string;
}
export interface FreshnessLabelProps extends Passthrough {
  freshness: Freshness;
  asOf?: string | number | Date;
  source?: string;
}
export interface UnavailableProps extends Passthrough {
  status?: 'partial' | 'unsupported';
  capability?: string;
  title?: string;
  reason?: ReactNode;
  /** Render the title as a heading (h1–h6) instead of a paragraph. */
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  children?: ReactNode;
}
export interface LoadingProps extends Passthrough { what?: string; long?: boolean }
export interface EmptyStateProps extends Passthrough {
  variant?: 'empty' | 'no-match';
  title?: string;
  body?: ReactNode;
  action?: ReactNode;
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
}
export interface ErrorPanelProps extends Passthrough {
  title?: string;
  message?: ReactNode;
  code?: string;
  requestId?: string;
  onRetry?: () => void;
  retryLabel?: string;
  actions?: ReactNode;
}
export interface MetadataItem {
  label: ReactNode;
  value?: ReactNode;
  hint?: ReactNode;
  mono?: boolean;
  attrs?: Record<string, string>;
}
export interface MetadataListProps extends Passthrough { items: MetadataItem[] }
export interface ResourceIdentityProps extends Passthrough {
  kind?: string;
  name?: string;
  id?: string;
  length?: number;
  href?: string;
}
export interface PageHeaderProps extends Passthrough {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
}
export interface ButtonProps extends Passthrough {
  label: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  type?: 'button' | 'submit';
  busy?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

export interface BreadcrumbsProps extends Passthrough {
  items: Array<{ label: ReactNode; href?: string }>;
  label?: string;
}
export interface TabItem {
  id: string;
  label: ReactNode;
  disabled?: boolean;
  /** Why a disabled tab cannot be chosen; shown as its title. */
  reason?: string;
  badge?: ReactNode;
  className?: string;
  attrs?: Record<string, string>;
}
export interface TabsProps extends Passthrough {
  tabs: TabItem[];
  active?: string;
  onSelect?: (id: string) => void;
  /** Accessible name of the tablist. */
  label?: string;
  /** Prefix for tab ids (`<prefix>-tab-<id>`); unique per page. */
  idPrefix?: string;
  /** Id of the TabPanel the tabs control. */
  panelId?: string;
}
export interface TabPanelProps extends Passthrough {
  id: string;
  idPrefix?: string;
  /** The selected tab's id, which labels the panel. */
  active?: string;
  children?: ReactNode;
}
export interface DataTableColumn { id: string; header: ReactNode; sortable?: boolean; align?: 'start' | 'end' }
export interface DataTableRow {
  /** The row's identity, so a row keeps its DOM (and focus) across pages and filters. */
  key: string;
  /** Cell content by column id. Missing or null renders an em dash. */
  cells: Record<string, ReactNode>;
  onSelect?: () => void;
  /** The open row: highlighted, and `aria-current="true"`. */
  selected?: boolean;
  className?: string;
  attrs?: Record<string, string>;
}
export interface DataTableProps extends Passthrough {
  /** The table's accessible name and caption. */
  label: string;
  columns: DataTableColumn[];
  rows: DataTableRow[];
  sort?: { column: string; direction: 'ascending' | 'descending' };
  onSort?: (columnId: string) => void;
  captionVisible?: boolean;
  loading?: boolean;
  loadingWhat?: string;
  error?: { title?: string; message?: ReactNode; code?: string; requestId?: string; onRetry?: () => void } | null;
  noMatch?: boolean;
  noMatchTitle?: string;
  noMatchBody?: ReactNode;
  emptyTitle?: string;
  emptyBody?: ReactNode;
  emptyAction?: ReactNode;
  emptyHeadingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
}
export interface FilterField {
  id: string;
  label: string;
  type?: 'text' | 'select';
  value?: string;
  placeholder?: string;
  options?: Array<string | { value: string; label: string }>;
}
export interface FilterBarProps extends Passthrough {
  /** Filters apply as they change: no Apply button (Enter still never navigates). */
  live?: boolean;
  filters: FilterField[];
  onChange?: (id: string, value: string) => void;
  onSubmit?: () => void;
  onClear?: () => void;
  /** How many filters are applied; Clear appears when this is above zero. */
  applied?: number;
  /** Announced politely, e.g. "3 records match". */
  result?: string;
  label?: string;
  idPrefix?: string;
  applyLabel?: string;
  clearLabel?: string;
}
export interface PaginationProps extends Passthrough {
  hasPrevious?: boolean;
  hasNext?: boolean;
  onPrevious?: () => void;
  onNext?: () => void;
  /** What the product can state truthfully, e.g. "8 shown". Never an invented total. */
  summary?: ReactNode;
  label?: string;
  previousLabel?: string;
  nextLabel?: string;
}
export type ThemePreference = 'system' | 'light' | 'dark';
export interface ShellNavItem {
  id: string;
  label: ReactNode;
  href: string;
  group?: string;
  order?: number;
  current?: boolean;
  className?: string;
  attrs?: Record<string, string>;
}
export interface ShellProps extends Passthrough {
  /** `id` is the product's Boundry portfolio id (e.g. "feltdb"): it sets the product accent, links to boundry.company and lists sibling products by default. */
  product: { id?: string; name: string; homeHref: string; mark?: string };
  navigation: ShellNavItem[];
  /** Product-owned context control, e.g. Compute's Work/Manage mode. */
  context?: ReactNode;
  /** Product-owned search, where the product supports one. */
  search?: ReactNode;
  /** Product-owned account or session controls. */
  account?: ReactNode;
  /** Omit for a product drawn in one theme only. */
  theme?: { preference: ThemePreference; onChange?: (preference: ThemePreference) => void } | null;
  activityHref?: string;
  activityLabel?: string;
  activityCurrent?: boolean;
  /** Defaults to the other Boundry portfolio products when `product.id` is in the portfolio; [] shows none. */
  otherProducts?: Array<{ id?: string; name: string; href: string }>;
  otherProductsLabel?: string;
  /** false hides the "A Boundry product" link and the About Boundry entry. */
  family?: boolean;
  /**
   * For client-side routing: called with the href of an ordinary left click on
   * the product link or a navigation item, instead of a page load. Clicks with
   * a modifier key stay normal links. Links to other products are never routed.
   */
  onNavigate?: (href: string) => void;
  /**
   * Below 768px: `'strip'` (default) keeps the navigation as a horizontal strip
   * that scrolls on its own; `'menu'` puts it behind a menu button in the bar.
   * Menu mode needs `onNavigationToggle`; the product owns the open state.
   */
  narrowNavigation?: 'strip' | 'menu';
  /** Menu mode: whether the navigation menu is open. */
  navigationOpen?: boolean;
  /** Menu mode: called with the new open state (button, Escape, following a link). */
  onNavigationToggle?: (open: boolean) => void;
  /** Menu mode: the menu button's accessible name. Default "Menu". */
  menuLabel?: string;
  /** Id of the main landmark; the skip link targets it. Default `stack-main`. */
  mainId?: string;
  mainAttrs?: Record<string, string>;
  skipLabel?: string;
  children?: ReactNode;
}

export declare function Breadcrumbs(props: BreadcrumbsProps): ReactElement;
export declare function Tabs(props: TabsProps): ReactElement;
export declare function TabPanel(props: TabPanelProps): ReactElement;
export declare function DataTable(props: DataTableProps): ReactElement;
export declare function FilterBar(props: FilterBarProps): ReactElement;
export declare function Pagination(props: PaginationProps): ReactElement;
export declare function Shell(props: ShellProps): ReactElement;

export declare const THEME_STORAGE_KEY: string;
/** Script text for a pre-rendered page's <head>: applies the stored theme before first paint. */
export declare const THEME_INIT_SCRIPT: string;
export declare const THEME_PREFERENCES: readonly ThemePreference[];
type StorageScope = { localStorage?: Storage } | typeof globalThis;
export declare function readThemePreference(scope?: StorageScope): ThemePreference;
export declare function storeThemePreference(preference: ThemePreference, scope?: StorageScope): boolean;
export declare function applyThemePreference(preference: ThemePreference, root?: Element): void;
export declare function initThemePreference(scope?: StorageScope, root?: Element): ThemePreference;
export declare function setThemePreference(preference: string, scope?: StorageScope, root?: Element): ThemePreference;

/** Moves focus to the shell's main landmark (by id) after a route change. */
export declare function focusMain(id?: string, doc?: Document): void;
export declare function StatusIndicator(props: StatusIndicatorProps): ReactElement;
export declare function VerificationBadge(props: VerificationBadgeProps): ReactElement;
export declare function FreshnessLabel(props: FreshnessLabelProps): ReactElement;
export declare function Unavailable(props: UnavailableProps): ReactElement;
export declare function Loading(props: LoadingProps): ReactElement;
export declare function EmptyState(props: EmptyStateProps): ReactElement;
export declare function ErrorPanel(props: ErrorPanelProps): ReactElement;
export declare function MetadataList(props: MetadataListProps): ReactElement;
export declare function ResourceIdentity(props: ResourceIdentityProps): ReactElement;
export declare function PageHeader(props: PageHeaderProps): ReactElement;
export declare function Button(props: ButtonProps): ReactElement;

export declare function resolve(field: string, value: unknown, options?: { label?: string }): {
  field: string; value: string; tone: Tone; label: string; glyph: string; mapped: boolean;
};
export interface NormalizedCheck { label: string; status?: 'passed' | 'failed' }
export declare function verification(state: string, checks?: Check[]): { state: VerificationState; checks: NormalizedCheck[] };
export declare function verificationOf(field: string, value: unknown, checks?: Check[]): { state: VerificationState; checks: NormalizedCheck[] };
export declare function freshnessOf(field: string, value: unknown): Freshness;
export declare function capability(status: unknown): 'available' | 'partial' | 'unsupported';
export declare function humanize(value: unknown): string;
export declare const TONES: readonly Tone[];
export declare const GLYPHS: Readonly<Record<Tone, string>>;
export declare function toReact(value: unknown, key?: string | number): ReactNode;

// ---- Forms and dialogs (PR4) ------------------------------------------------

interface FieldBase extends Passthrough {
  /** Control id; defaults to `stack-field-<name>`. The label, hint and error are wired to it. */
  id?: string;
  name?: string;
  /** Always visible. Never replaced by a placeholder. */
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  readOnly?: boolean;
  disabled?: boolean;
}
export interface TextFieldProps extends FieldBase {
  value?: string | number;
  /** Called with the new value on every edit. Without it the control is uncontrolled. */
  onChange?: (value: string) => void;
  type?: 'text' | 'email' | 'url' | 'number' | 'password' | 'search' | 'tel';
  placeholder?: string;
  /** A textarea instead of an input. */
  multiline?: boolean;
  rows?: number;
  pattern?: string;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  minlength?: number;
  maxlength?: number;
  autocomplete?: string;
  inputmode?: string;
  list?: string;
  spellcheck?: 'true' | 'false';
}
export type SelectOption = string | { value: string; label: string; disabled?: boolean };
export interface SelectProps extends FieldBase {
  value?: string;
  onChange?: (value: string) => void;
  options: SelectOption[];
}
export interface FormProps extends Passthrough {
  id?: string;
  /** Accessible name for the form. */
  label?: string;
  submitLabel?: string;
  submitVariant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  /** Marks the submit button while the product's request is in flight. */
  busy?: boolean;
  /** Called on submit; the default navigation is always prevented. */
  onSubmit?: (event: { preventDefault(): void; target: EventTarget | null }) => void;
  /** Extra buttons beside submit (e.g. Cancel). */
  actions?: ReactNode;
  layout?: 'stacked' | 'inline';
  children?: ReactNode;
}
export interface DialogProps extends Passthrough {
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  role?: 'dialog' | 'alertdialog';
  /** React only: shown as a modal while true. */
  open?: boolean;
  /** Esc, and the product's own Cancel. */
  onClose?: () => void;
  actions?: ReactNode;
  children?: ReactNode;
}
export interface ConfirmActionProps extends Passthrough {
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  /** What will happen, as the product states it. */
  consequences?: ReactNode[];
  /** Names the action, e.g. "Revoke API key". Never "OK". */
  confirmLabel: string;
  cancelLabel?: string;
  /** Typed confirmation for irreversible deletes of named resources. */
  requireText?: string;
  requireTextLabel?: string;
  typed?: string;
  onTypedChange?: (value: string) => void;
  busy?: boolean;
  error?: { title?: string; message?: ReactNode; code?: string; requestId?: string } | null;
  onConfirm?: () => void;
  onCancel?: () => void;
  /** React only: shown as a modal while true. */
  open?: boolean;
}
export declare function TextField(props: TextFieldProps): ReactElement;
export declare function Select(props: SelectProps): ReactElement;
export declare function Form(props: FormProps): ReactElement;
export declare function Dialog(props: DialogProps): ReactElement;
export declare function ConfirmAction(props: ConfirmActionProps): ReactElement;

/** Framework-free helpers (they render with dom.js into the given document). */
export declare function openDialog(dialog: HTMLDialogElement, doc?: Document): () => void;
export declare function confirmAction(
  props: Omit<ConfirmActionProps, 'open' | 'typed' | 'onTypedChange' | 'onConfirm' | 'onCancel' | 'busy' | 'error'> & { action?: () => Promise<unknown> },
  doc?: Document,
): Promise<boolean>;
export declare function formDialog(
  props: {
    id?: string; title: string; description?: string; submitLabel?: string; cancelLabel?: string;
    fields: Array<(Omit<TextFieldProps, 'onChange'> | Omit<SelectProps, 'onChange'>) & { name: string }>;
    action?: (values: Record<string, string>) => Promise<unknown>;
  },
  doc?: Document,
): Promise<Record<string, string> | null>;

// ---- Evidence (PR5) ---------------------------------------------------------

export interface EvidenceClaim {
  label: ReactNode;
  /** Missing (null, undefined or '') renders an em dash, never a default. */
  value?: ReactNode;
  /** Only for a claim the product checked. Without it the claim is a recorded fact. */
  verification?: VerificationState;
  checks?: Check[];
  evidenceHref?: string;
  mono?: boolean;
  attrs?: Record<string, string>;
}
export interface EvidenceSummaryProps extends Passthrough {
  id?: string;
  title?: ReactNode;
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  /** What the record concluded, e.g. a StatusIndicator of the decision. */
  outcome?: ReactNode;
  claims: EvidenceClaim[];
  /** Who recorded it, e.g. "Recorded by AuthBoundry". */
  source?: ReactNode;
  recordedAt?: string | number | Date;
}
export declare function EvidenceSummary(props: EvidenceSummaryProps): ReactElement;

// ---- Notices, choices and history (0.6.0) ------------------------------------

export interface AlertProps extends Passthrough {
  /** Information is not a state: info, attention or critical only. */
  tone?: 'info' | 'attention' | 'critical';
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}
export interface CheckboxProps extends Passthrough {
  id?: string;
  name?: string;
  value?: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  checked?: boolean;
  required?: boolean;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
}
export interface FieldGroupProps extends Passthrough {
  id?: string;
  legend: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  children?: ReactNode;
}
export interface ActivityItem {
  id?: string;
  /** When it happened; missing renders "Time not recorded", never a guess. */
  at?: string | number | Date;
  actor?: ReactNode;
  summary: ReactNode;
  /** e.g. a StatusIndicator for the event's outcome. */
  status?: ReactNode;
  detail?: ReactNode;
  href?: string;
  attrs?: Record<string, string>;
}
export interface ActivityTimelineProps extends Passthrough {
  label?: string;
  items: ActivityItem[];
  loading?: boolean;
  error?: string | ErrorPanelProps;
  emptyTitle?: string;
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  /** Older activity exists: say so rather than implying the list is complete. */
  hasMore?: boolean;
  moreHref?: string;
  moreLabel?: string;
  onMore?: () => void;
  what?: string;
}
export declare function Alert(props: AlertProps): ReactElement;
export declare function Checkbox(props: CheckboxProps): ReactElement;
export declare function FieldGroup(props: FieldGroupProps): ReactElement;
export declare function ActivityTimeline(props: ActivityTimelineProps): ReactElement;

// ---- Brand and marketing foundation (0.6.0) -----------------------------------

export type PortfolioId = 'feltdb' | 'feltkit' | 'appboundry' | 'authboundry' | 'appport';
export interface PortfolioProduct { id: PortfolioId; name: string; mark: string; category: string; href: string }
export declare const PORTFOLIO: {
  readonly company: { name: string; href: string; tagline: string; family: string };
  readonly products: readonly PortfolioProduct[];
};
export declare function portfolioProduct(id: string): PortfolioProduct | null;

export interface BrandMarkProps extends Passthrough {
  /** Unique per page: the gradient is referenced by id. */
  idPrefix?: string;
  /** Accessible name; without it the mark is decorative. */
  title?: string;
}
export interface ThemeSwitchProps extends Passthrough {
  id?: string;
  label?: string;
  preference?: ThemePreference;
  onChange?: (preference: ThemePreference) => void;
}
export interface SiteLink { label: ReactNode; href: string; current?: boolean; attrs?: Record<string, string> }
export interface SiteHeaderProps extends Passthrough {
  /** A product site: its portfolio id, optionally overriding name or mark. Omit for the Boundry company site. */
  product?: { id: PortfolioId | string; name?: string; mark?: string };
  homeHref?: string;
  /** The product's own logo; defaults to its accent mark (or the Boundry mark on the company site). */
  logo?: ReactNode;
  navigation?: SiteLink[];
  navigationLabel?: string;
  theme?: { preference: ThemePreference; onChange?: (preference: ThemePreference) => void } | null;
  actions?: ReactNode;
  mainId?: string;
  skipLabel?: string;
}
export interface SiteFooterProps extends Passthrough {
  id?: string;
  product?: { id: PortfolioId | string; name?: string };
  tagline?: ReactNode;
  columns?: Array<{ title: string; links: SiteLink[] }>;
  year?: number | string;
  owner?: string;
  legal?: ReactNode;
}
export declare function BrandMark(props: BrandMarkProps): ReactElement;
export declare function ThemeSwitch(props: ThemeSwitchProps): ReactElement;
export declare function SiteHeader(props: SiteHeaderProps): ReactElement;
export declare function SiteFooter(props: SiteFooterProps): ReactElement;
